// Live mode with OpenAI models, through the official OpenAI SDK (Responses API, streamed).
//
// Works like the Claude responder: the model can call the read-only mock tools to inspect real
// data before it writes the answer (see live.mjs), and only the final turn's text reaches the app.
// Requests are stateless (`store: false`): reasoning comes back encrypted and is passed along
// with the tool results.

import OpenAI from "openai";
import { loadLiveSetup, MAX_TOOL_ROUNDS } from "./live.mjs";
import { toConversation } from "./messages.mjs";

export const DEFAULT_OPENAI_MODEL = "gpt-5.5";

/** Reasoning models take a reasoning effort; other models reject it. */
function isReasoningModel(model) {
  return /^(o\d|gpt-5)/.test(model) && !model.includes("chat");
}

/** Creates the OpenAI responder. The client reads OPENAI_API_KEY from the environment. */
export async function createOpenAIResponder({
  client = new OpenAI(),
  model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
  // Low effort keeps the wait before the UI starts streaming short; set it to "" to omit it.
  reasoningEffort = process.env.OPENAI_REASONING_EFFORT ?? (isReasoningModel(model) ? "low" : ""),
  log = console.log,
} = {}) {
  const live = await loadLiveSetup();
  const modelTools = (format) =>
    live.readSpecs(format).map((spec) => ({
      type: "function",
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
      strict: false,
    }));

  async function runToolCall(call) {
    let input;
    try {
      input = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return `Error: the arguments weren't valid JSON: ${call.arguments}`;
    }
    const result = await live.runTool(call.name, input);
    return result.ok ? result.content : `Error: ${result.message}`;
  }

  return {
    provider: "openai",
    model,
    async respond({ messages, format, send, signal }) {
      // The large OpenUI prompt comes first so OpenAI's automatic prefix caching can reuse it.
      const { prefix, context } = live.systemPrompts(format);
      const instructions = prefix ? `${prefix}\n\n${context}` : context;
      const input = toConversation(messages);
      let streamedText = false;

      for (let round = 0; ; round++) {
        let response = null;
        let refused = false;
        send({ type: "status", status: "thinking" });
        try {
          const stream = await client.responses.create(
            {
              model,
              instructions,
              input,
              tools: modelTools(format),
              // After a few rounds of lookups, answer with the data at hand.
              tool_choice: round < MAX_TOOL_ROUNDS ? "auto" : "none",
              stream: true,
              store: false,
              include: ["reasoning.encrypted_content"],
              ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
            },
            { signal },
          );
          for await (const event of stream) {
            switch (event.type) {
              case "response.output_item.added":
                if (event.item.type === "function_call") send({ type: "status", status: "tool", tool: event.item.name });
                else if (event.item.type === "message") send({ type: "status", status: "writing" });
                break;
              case "response.output_text.delta":
                streamedText = true;
                send({ type: "delta", text: event.delta });
                break;
              case "response.refusal.delta":
                refused = true;
                break;
              case "response.completed":
              case "response.incomplete":
                response = event.response;
                break;
              case "response.failed":
                throw new Error(event.response?.error?.message ?? "The response failed.");
              case "error":
                throw new Error(event.message);
            }
          }
        } catch (error) {
          if (signal.aborted || error instanceof OpenAI.APIUserAbortError) return;
          throw new Error(describeOpenAIError(error, model), { cause: error });
        }
        if (!response) throw new Error("The OpenAI stream ended without a response.");

        const { usage } = response;
        if (usage) {
          log(
            `openai: ${response.model} status=${response.status} in=${usage.input_tokens} ` +
              `cached=${usage.input_tokens_details?.cached_tokens ?? 0} out=${usage.output_tokens} ` +
              `reasoning=${usage.output_tokens_details?.reasoning_tokens ?? 0}`,
          );
        }
        const incompleteReason = response.status === "incomplete" ? response.incomplete_details?.reason : null;
        if (refused || incompleteReason === "content_filter") {
          send({ type: "refusal", message: "The model declined to answer this request." });
          return;
        }
        const calls = response.output.filter((item) => item.type === "function_call");
        if (incompleteReason || calls.length === 0) {
          send({ type: "done", stopReason: incompleteReason ? "max_tokens" : "end_turn", model: response.model });
          return;
        }

        // Text before a tool call isn't part of the answer: clear it in the app.
        if (streamedText) send({ type: "reset" });
        streamedText = false;
        // Pass back everything the model produced (including encrypted reasoning) with the results.
        input.push(...response.output);
        for (const call of calls) {
          input.push({ type: "function_call_output", call_id: call.call_id, output: await runToolCall(call) });
        }
      }
    },
  };
}

/** A user-facing description of an OpenAI SDK error. */
export function describeOpenAIError(error, model) {
  if (error instanceof OpenAI.AuthenticationError) {
    return "The OpenAI API rejected the credentials. Check OPENAI_API_KEY and restart the backend.";
  }
  if (error instanceof OpenAI.PermissionDeniedError || error instanceof OpenAI.NotFoundError) {
    return `This API key can't use ${model}. Set OPENAI_MODEL to a model it has access to.`;
  }
  if (error instanceof OpenAI.RateLimitError) {
    return "The OpenAI API is rate limiting requests, or the account is out of credit. Try again in a moment.";
  }
  if (error instanceof OpenAI.BadRequestError) {
    return `The OpenAI API rejected the request: ${error.message}`;
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return "Couldn't reach the OpenAI API. Check the backend's network connection.";
  }
  if (error instanceof OpenAI.APIError) {
    return `OpenAI API error${error.status ? ` ${error.status}` : ""}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
