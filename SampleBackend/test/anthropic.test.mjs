// Exercises the live responder against a local fake of the Messages API, so the SDK integration
// (streaming, tool loop, fallbacks, refusals, errors) is tested without network access or cost.

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicResponder, echoableContent } from "../src/anthropic.mjs";

/** Builds the SSE events of one streamed message from a compact block description. */
function messageEvents({ blocks, stopReason, model = "claude-opus-5-5" }) {
  const usage = { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const events = [
    {
      type: "message_start",
      message: { id: "msg_test", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage },
    },
  ];
  blocks.forEach((block, index) => {
    switch (block.type) {
      case "thinking":
        events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
        events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: `sig-${index}` } });
        break;
      case "text":
        events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
        for (const text of block.pieces) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
        break;
      case "tool_use":
        events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
        events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: block.json } });
        break;
      case "fallback":
        events.push({
          type: "content_block_start",
          index,
          content_block: { type: "fallback", from: { model: block.from }, to: { model: block.to }, trigger: { type: "refusal", category: null } },
        });
        break;
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 42 } });
  events.push({ type: "message_stop" });
  return events;
}

describe("Claude responder", () => {
  let fakeAPI;
  let baseURL;
  let requests = [];
  let replies = [];

  before(async () => {
    fakeAPI = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
      const reply = replies.shift() ?? { httpStatus: 500, error: { type: "api_error", message: "no scripted reply" } };
      if (reply.httpStatus) {
        res.writeHead(reply.httpStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: reply.error }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of messageEvents(reply)) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise((resolve) => fakeAPI.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${fakeAPI.address().port}`;
  });

  after(() => new Promise((resolve) => fakeAPI.close(resolve)));

  beforeEach(() => {
    requests = [];
    replies = [];
  });

  async function respond(format = "openui", messages = [{ role: "user", content: "Find hotels in Ohrid" }]) {
    const client = new Anthropic({ apiKey: "test-key", baseURL, maxRetries: 0 });
    const responder = await createAnthropicResponder({ client, log: () => {} });
    const events = [];
    await responder.respond({ messages, format, send: (event) => events.push(event), signal: new AbortController().signal });
    return events;
  }

  const text = (events) =>
    events
      .filter((event) => event.type === "delta")
      .map((event) => event.text)
      .join("");

  test("sends the documented request shape", async () => {
    replies = [{ blocks: [{ type: "text", pieces: ["root = Card([])"] }], stopReason: "end_turn" }];
    await respond();

    const [{ path, headers, body }] = requests;
    assert.equal(path, "/v1/messages?beta=true");
    assert.match(headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.stream, true);
    assert.equal(body.fallbacks, "default");
    assert.deepEqual(body.output_config, { effort: "medium" });
    assert.deepEqual(body.cache_control, { type: "ephemeral" });
    assert.equal(body.betas, undefined);
    assert.equal(body.thinking, undefined);

    // The generated OpenUI prompt is cached; the app context with the date follows it.
    assert.equal(body.system.length, 2);
    assert.match(body.system[0].text, /^You are an AI assistant that responds using openui-lang/);
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
    assert.match(body.system[1].text, /OpenUI Demo/);
    assert.equal(body.system[1].cache_control, undefined);

    // Only the read-only tools are callable by the model.
    assert.deepEqual(
      body.tools.map((tool) => tool.name),
      ["search_hotels", "get_weather", "find_photos", "scale_recipe"],
    );
    assert.ok(body.tools.every((tool) => tool.eager_input_streaming === true && tool.input_schema.type === "object"));
    assert.deepEqual(body.tool_choice, { type: "auto" });
    assert.deepEqual(body.messages, [{ role: "user", content: "Find hotels in Ohrid" }]);
  });

  test("markdown mode uses the markdown prompt", async () => {
    replies = [{ blocks: [{ type: "text", pieces: ["## Hi"] }], stopReason: "end_turn" }];
    const events = await respond("markdown");
    assert.equal(text(events), "## Hi");
    assert.equal(requests[0].body.system.length, 1);
    assert.match(requests[0].body.system[0].text, /GitHub-flavored Markdown/);
    // Markdown answers don't show images, so the photo tool isn't offered.
    assert.deepEqual(
      requests[0].body.tools.map((tool) => tool.name),
      ["search_hotels", "get_weather", "scale_recipe"],
    );
  });

  test("streams text deltas and finishes", async () => {
    replies = [
      {
        blocks: [{ type: "thinking" }, { type: "text", pieces: ["root = Card(", "[header])\n", 'header = CardHeader("Hi")'] }],
        stopReason: "end_turn",
      },
    ];
    const events = await respond();
    assert.deepEqual(
      events.map((event) => event.type),
      ["meta", "status", "status", "delta", "delta", "delta", "done"],
    );
    assert.deepEqual(events[1], { type: "status", status: "thinking" });
    assert.equal(text(events), 'root = Card([header])\nheader = CardHeader("Hi")');
    assert.deepEqual(events.at(-1), { type: "done", stopReason: "end_turn", model: "claude-opus-5-5" });
  });

  test("runs read-only tools and sends their results back", async () => {
    replies = [
      {
        blocks: [{ type: "thinking" }, { type: "tool_use", id: "toolu_1", name: "search_hotels", json: '{"city": "Ohrid", "maxPrice": 70}' }],
        stopReason: "tool_use",
      },
      { blocks: [{ type: "text", pieces: ["root = Card([])"] }], stopReason: "end_turn" },
    ];
    const events = await respond();
    assert.equal(text(events), "root = Card([])");
    assert.ok(events.some((event) => event.type === "status" && event.status === "tool" && event.tool === "search_hotels"));

    assert.equal(requests.length, 2);
    const [user, assistant, toolResults] = requests[1].body.messages;
    assert.deepEqual(user, { role: "user", content: "Find hotels in Ohrid" });
    // The assistant turn is echoed unchanged, thinking signature included.
    assert.deepEqual(assistant, {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-0" },
        { type: "tool_use", id: "toolu_1", name: "search_hotels", input: { city: "Ohrid", maxPrice: 70 } },
      ],
    });
    assert.equal(toolResults.role, "user");
    assert.equal(toolResults.content.length, 1);
    const [result] = toolResults.content;
    assert.equal(result.type, "tool_result");
    assert.equal(result.tool_use_id, "toolu_1");
    assert.equal(result.is_error, undefined);
    assert.deepEqual(
      JSON.parse(result.content).hotels.map((hotel) => hotel.name),
      ["Čaršija Hostel", "Kaneo Lakeview Rooms", "Varoš Stone House"],
    );
  });

  test("answers invalid tool input with an error result instead of running the tool", async () => {
    replies = [
      { blocks: [{ type: "tool_use", id: "toolu_1", name: "search_hotels", json: '{"city": 42}' }], stopReason: "tool_use" },
      { blocks: [{ type: "text", pieces: ["root = Card([])"] }], stopReason: "end_turn" },
    ];
    await respond();
    const [result] = requests[1].body.messages[2].content;
    assert.equal(result.is_error, true);
    assert.deepEqual(JSON.parse(result.content), { INVALID_JSON: '{"city":42}' });
  });

  test("clears text written before a tool call", async () => {
    replies = [
      {
        blocks: [{ type: "text", pieces: ["Let me check."] }, { type: "tool_use", id: "toolu_1", name: "get_weather", json: '{"city": "Ohrid"}' }],
        stopReason: "tool_use",
      },
      { blocks: [{ type: "text", pieces: ["root = Card([])"] }], stopReason: "end_turn" },
    ];
    const events = await respond();
    const types = events.map((event) => event.type);
    const reset = types.indexOf("reset");
    assert.ok(reset > types.indexOf("delta"), "reset follows the discarded text");
    const answer = events.slice(reset + 1).filter((event) => event.type === "delta").map((event) => event.text).join("");
    assert.equal(answer, "root = Card([])");
  });

  test("asks for an answer after the maximum number of tool rounds", async () => {
    const lookup = (id) => ({ blocks: [{ type: "tool_use", id, name: "get_weather", json: '{"city": "Ohrid"}' }], stopReason: "tool_use" });
    replies = [lookup("toolu_1"), lookup("toolu_2"), lookup("toolu_3"), { blocks: [{ type: "text", pieces: ["root = Card([])"] }], stopReason: "end_turn" }];
    const events = await respond();
    assert.equal(requests.length, 4);
    assert.deepEqual(
      requests.map((request) => request.body.tool_choice.type),
      ["auto", "auto", "auto", "none"],
    );
    assert.equal(text(events), "root = Card([])");
  });

  test("continues seamlessly across a server-side fallback", async () => {
    replies = [
      {
        blocks: [
          { type: "text", pieces: ["root = Ca"] },
          { type: "fallback", from: "claude-opus-5-5", to: "claude-opus-4-8" },
          { type: "text", pieces: ["rd([])"] },
        ],
        stopReason: "end_turn",
      },
    ];
    const events = await respond();
    assert.equal(text(events), "root = Card([])");
    assert.ok(events.some((event) => event.type === "fallback" && event.from === "claude-opus-5-5" && event.to === "claude-opus-4-8"));
    assert.deepEqual(events.at(-1), { type: "done", stopReason: "end_turn", model: "claude-opus-4-8" });
  });

  test("reports a refusal instead of finishing", async () => {
    replies = [{ blocks: [{ type: "text", pieces: ["root = "] }], stopReason: "refusal" }];
    const events = await respond();
    assert.equal(events.at(-1).type, "refusal");
    assert.ok(!events.some((event) => event.type === "done"));
  });

  test("turns API errors into readable messages", async () => {
    replies = [{ httpStatus: 401, error: { type: "authentication_error", message: "invalid x-api-key" } }];
    await assert.rejects(respond(), /rejected the credentials/);

    replies = [{ httpStatus: 400, error: { type: "invalid_request_error", message: "bad field" } }];
    await assert.rejects(respond(), /rejected the request/);
  });
});

describe("echoableContent", () => {
  test("keeps content without a fallback unchanged", () => {
    const content = [{ type: "thinking" }, { type: "text", text: "a" }];
    assert.equal(echoableContent(content), content);
  });

  test("drops declined thinking and tool calls before the last fallback block", () => {
    const content = [
      { type: "thinking", signature: "a" },
      { type: "text", text: "partial" },
      { type: "tool_use", id: "t1" },
      { type: "fallback" },
      { type: "thinking", signature: "b" },
      { type: "tool_use", id: "t2" },
    ];
    assert.deepEqual(
      echoableContent(content).map((block) => block.signature ?? block.text ?? block.id ?? block.type),
      ["partial", "fallback", "b", "t2"],
    );
  });
});
