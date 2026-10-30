// Live mode with Claude, through the official Anthropic SDK.
//
// Claude can call the read-only mock tools to inspect real data before it writes the answer (see
// live.mjs). Only the text of the final turn is streamed to the app.

import Anthropic from "@anthropic-ai/sdk";
import { loadLiveSetup, MAX_TOOL_ROUNDS } from "./live.mjs";
import { toConversation } from "./messages.mjs";

export const DEFAULT_MODEL = "claude-opus-5-5";
/** Consecutive re-issues of a turn whose tool input couldn't be parsed. */
const MAX_JSON_RETRIES = 2;

/**
 * Creates the Claude responder. The client reads credentials from the environment
 * (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN).
 */
export async function createAnthropicResponder({
  client = new Anthropic(),
  model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
  effort = process.env.OPENUI_EFFORT || "medium",
  maxTokens = Number(process.env.OPENUI_MAX_TOKENS || 32000),
  log = console.log,
} = {}) {
  const live = await loadLiveSetup();
  const modelTools = (format) =>
    live.readSpecs(format).map((spec) => ({
      name: spec.name,
      description: spec.description,
      input_schema: spec.inputSchema,
      // Stream tool input as it is generated; inputs are validated below before a tool runs.
      eager_input_streaming: true,
    }));
  async function runTool(block) {
    const result = await live.runTool(block.name, block.input);
    if (result.ok) return { type: "tool_result", tool_use_id: block.id, content: result.content };
    // Eager input streaming skips server-side validation; invalid input goes back like invalid JSON.
    const content = result.reason === "invalid" ? JSON.stringify({ INVALID_JSON: JSON.stringify(block.input) }) : result.message;
    return { type: "tool_result", tool_use_id: block.id, is_error: true, content };
  }

  return {
    provider: "anthropic",
    model,
    async respond({ messages, format, send, signal }) {
      // The generated OpenUI prompt is large and identical for every request, so it gets its own
      // cache breakpoint; the date-dependent app context follows it. Top-level cache_control
      // also caches the growing conversation for the next turn.
      const { prefix, context } = live.systemPrompts(format);
      const system = [
        ...(prefix ? [{ type: "text", text: prefix, cache_control: { type: "ephemeral" } }] : []),
        { type: "text", text: context },
      ];
      const conversation = toConversation(messages);
      let streamedText = false;
      let jsonRetries = 0;

      for (let round = 0; ; round++) {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: maxTokens,
          // Thinking is always on for this model; effort controls depth, latency and cost.
          output_config: { effort },
          // If the model declines for policy reasons, the API retries on Anthropic's recommended
          // fallback model inside the same streamed response.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          cache_control: { type: "ephemeral" },
          system,
          tools: modelTools(format),
          // After a few rounds of lookups, answer with the data at hand.
          tool_choice: { type: round < MAX_TOOL_ROUNDS ? "auto" : "none" },
          messages: conversation,
        });
        const abort = () => stream.abort();
        signal.addEventListener("abort", abort, { once: true });

        let message;
        try {
          for await (const event of stream) {
            if (event.type === "message_start") {
              send({ type: "meta", model: event.message.model });
            } else if (event.type === "content_block_start") {
              const block = event.content_block;
              if (block.type === "thinking" || block.type === "redacted_thinking") {
                send({ type: "status", status: "thinking" });
              } else if (block.type === "text") {
                send({ type: "status", status: "writing" });
              } else if (block.type === "tool_use") {
                send({ type: "status", status: "tool", tool: block.name });
              } else if (block.type === "fallback") {
                log(`fallback: ${block.from?.model} declined, ${block.to?.model} continued`);
                send({ type: "fallback", from: block.from?.model ?? null, to: block.to?.model ?? null });
              }
            } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              streamedText = true;
              send({ type: "delta", text: event.delta.text });
            }
          }
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (error) {
          if (signal.aborted || error instanceof Anthropic.APIUserAbortError) return;
          if (error instanceof Anthropic.APIError || jsonRetries >= MAX_JSON_RETRIES) {
            throw new Error(describeError(error), { cause: error });
          }
          // A tool input that couldn't be parsed at all: re-issue the turn.
          jsonRetries += 1;
          log(`tool input was not parseable JSON, re-issuing the turn (${error.message})`);
          if (streamedText) send({ type: "reset" });
          streamedText = false;
          continue;
        } finally {
          signal.removeEventListener("abort", abort);
        }

        logUsage(log, message);
        if (message.stop_reason === "refusal") {
          // Every model in the fallback chain declined; whatever streamed is discarded by the app.
          send({ type: "refusal", message: "Claude declined to answer this request." });
          return;
        }
        const content = echoableContent(message.content);
        const toolUses = content.filter((block) => block.type === "tool_use");
        if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
          // end_turn, or max_tokens (a truncated answer, or a cut-off tool input that never runs).
          send({ type: "done", stopReason: message.stop_reason, model: message.model });
          return;
        }

        // Text before a tool call isn't part of the answer: clear it in the app.
        if (streamedText) send({ type: "reset" });
        streamedText = false;
        conversation.push({ role: "assistant", content });
        conversation.push({ role: "user", content: await Promise.all(toolUses.map(runTool)) });
      }
    },
  };
}

/**
 * The assistant content to send back in the next request. After a mid-output fallback, blocks of
 * the declined attempt that the fallback model can't continue from (thinking and tool calls before
 * the last `fallback` block) are left out; text and everything after the boundary are kept.
 */
export function echoableContent(content) {
  let boundary = -1;
  content.forEach((block, index) => {
    if (block.type === "fallback") boundary = index;
  });
  if (boundary < 0) return content;
  return content.filter((block, index) => index >= boundary || block.type === "text");
}

function logUsage(log, message) {
  const { usage } = message;
  log(
    `claude: ${message.model} stop=${message.stop_reason} in=${usage.input_tokens} ` +
      `cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0} ` +
      `out=${usage.output_tokens}`,
  );
}

/** A user-facing description of an SDK error. */
export function describeError(error) {
  if (error instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API rejected the credentials. Check ANTHROPIC_API_KEY and restart the backend.";
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return "This API key doesn't have access to the requested model.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "The Anthropic API is rate limiting requests. Wait a moment and try again.";
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `The Anthropic API rejected the request: ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Couldn't reach the Anthropic API. Check the backend's network connection.";
  }
  if (error instanceof Anthropic.APIError) {
    return error.status === 529
      ? "Claude is temporarily overloaded. Try again in a moment."
      : `Anthropic API error${error.status ? ` ${error.status}` : ""}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
