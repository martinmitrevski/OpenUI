// Exercises the OpenAI responder against a local fake of the Responses API, so the SDK integration
// (streaming, tool loop with encrypted reasoning, refusals, errors) is tested without network access
// or cost.

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import OpenAI from "openai";
import { createOpenAIResponder } from "../src/openai.mjs";

/** The streamed events of one response: reasoning, then an optional message, then function calls. */
function responseEvents({ text = [], refusal, calls = [], status = "completed", reason, model = "gpt-5.5-2026-04-23" }) {
  const output = [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted-reasoning" }];
  const events = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: output[0] },
  ];
  if (text.length || refusal) {
    const message = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [] };
    const index = output.length;
    events.push({ type: "response.output_item.added", output_index: index, item: { ...message, status: "in_progress" } });
    for (const delta of text) events.push({ type: "response.output_text.delta", item_id: "msg_1", output_index: index, content_index: 0, delta });
    if (refusal) events.push({ type: "response.refusal.delta", item_id: "msg_1", output_index: index, content_index: 0, delta: refusal });
    message.content.push(refusal ? { type: "refusal", refusal } : { type: "output_text", text: text.join(""), annotations: [] });
    output.push(message);
  }
  for (const call of calls) {
    const item = { type: "function_call", id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" };
    events.push({ type: "response.output_item.added", output_index: output.length, item: { ...item, arguments: "", status: "in_progress" } });
    events.push({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: output.length, delta: call.arguments });
    output.push(item);
  }
  const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120 };
  const response = { id: "resp_1", object: "response", model, status, output, incomplete_details: reason ? { reason } : null, usage };
  events.push({ type: status === "incomplete" ? "response.incomplete" : "response.completed", response });
  return events.map((event, index) => ({ ...event, sequence_number: index }));
}

describe("OpenAI responder", () => {
  let fakeAPI;
  let baseURL;
  let requests = [];
  let replies = [];

  before(async () => {
    fakeAPI = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
      const reply = replies.shift() ?? { httpStatus: 500, error: { message: "no scripted reply", type: "server_error" } };
      if (reply.httpStatus) {
        res.writeHead(reply.httpStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: reply.error }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const events = reply.events ?? responseEvents(reply);
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise((resolve) => fakeAPI.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${fakeAPI.address().port}/v1`;
  });

  after(() => new Promise((resolve) => fakeAPI.close(resolve)));

  beforeEach(() => {
    requests = [];
    replies = [];
  });

  async function respond({ format = "openui", model, messages = [{ role: "user", content: "Find hotels in Ohrid" }] } = {}) {
    const client = new OpenAI({ apiKey: "test-key", baseURL, maxRetries: 0 });
    const responder = await createOpenAIResponder({ client, model, log: () => {} });
    const events = [];
    await responder.respond({ messages, format, send: (event) => events.push(event), signal: new AbortController().signal });
    return events;
  }

  const text = (events) =>
    events
      .filter((event) => event.type === "delta")
      .map((event) => event.text)
      .join("");

  test("sends a stateless Responses API request", async () => {
    replies = [{ text: ["root = Card([])"] }];
    await respond();

    const [{ path, headers, body }] = requests;
    assert.equal(path, "/v1/responses");
    assert.equal(headers.authorization, "Bearer test-key");
    assert.equal(body.model, "gpt-5.5");
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.equal(body.tool_choice, "auto");
    assert.deepEqual(
      body.tools.map((tool) => tool.name),
      ["search_hotels", "get_weather", "find_photos", "scale_recipe"],
    );
    assert.ok(body.tools.every((tool) => tool.type === "function" && tool.strict === false && tool.parameters.type === "object"));

    // The cacheable OpenUI prompt comes first, followed by the app context.
    assert.match(body.instructions, /^You are an AI assistant that responds using openui-lang/);
    assert.match(body.instructions, /# This app\nYou are the assistant in "OpenUI Demo"/);
    assert.deepEqual(body.input, [{ role: "user", content: "Find hotels in Ohrid" }]);
  });

  test("leaves out the reasoning effort for non-reasoning models", async () => {
    replies = [{ text: ["root = Card([])"] }];
    await respond({ model: "gpt-4.1" });
    assert.equal(requests[0].body.reasoning, undefined);
  });

  test("markdown mode uses the markdown prompt", async () => {
    replies = [{ text: ["## Hi"] }];
    const events = await respond({ format: "markdown" });
    assert.equal(text(events), "## Hi");
    assert.match(requests[0].body.instructions, /GitHub-flavored Markdown/);
    assert.doesNotMatch(requests[0].body.instructions, /openui-lang, a declarative UI language/);
    // Markdown answers don't show images, so the photo tool isn't offered.
    assert.deepEqual(
      requests[0].body.tools.map((tool) => tool.name),
      ["search_hotels", "get_weather", "scale_recipe"],
    );
  });

  test("streams text deltas and finishes", async () => {
    replies = [{ text: ["root = Card(", "[header])\n", 'header = CardHeader("Hi")'] }];
    const events = await respond();
    assert.deepEqual(
      events.map((event) => event.type),
      ["status", "status", "delta", "delta", "delta", "done"],
    );
    assert.deepEqual(events[1], { type: "status", status: "writing" });
    assert.equal(text(events), 'root = Card([header])\nheader = CardHeader("Hi")');
    assert.deepEqual(events.at(-1), { type: "done", stopReason: "end_turn", model: "gpt-5.5-2026-04-23" });
  });

  test("runs read-only tools and passes reasoning and results back", async () => {
    replies = [{ calls: [{ id: "call_1", name: "search_hotels", arguments: '{"city":"Ohrid","maxPrice":70}' }] }, { text: ["root = Card([])"] }];
    const events = await respond();
    assert.equal(text(events), "root = Card([])");
    assert.ok(events.some((event) => event.type === "status" && event.status === "tool" && event.tool === "search_hotels"));

    assert.equal(requests.length, 2);
    const [user, reasoning, call, output] = requests[1].body.input;
    assert.deepEqual(user, { role: "user", content: "Find hotels in Ohrid" });
    assert.deepEqual(reasoning, { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted-reasoning" });
    assert.equal(call.type, "function_call");
    assert.equal(call.call_id, "call_1");
    assert.equal(output.type, "function_call_output");
    assert.equal(output.call_id, "call_1");
    assert.deepEqual(
      JSON.parse(output.output).hotels.map((hotel) => hotel.name),
      ["Čaršija Hostel", "Kaneo Lakeview Rooms", "Varoš Stone House"],
    );
  });

  test("answers invalid tool arguments with an error instead of running the tool", async () => {
    replies = [
      {
        calls: [
          { id: "call_1", name: "search_hotels", arguments: '{"city": 42}' },
          { id: "call_2", name: "get_weather", arguments: '{"city": "Ohr' },
        ],
      },
      { text: ["root = Card([])"] },
    ];
    await respond();
    const outputs = requests[1].body.input.filter((item) => item.type === "function_call_output");
    assert.deepEqual(
      outputs.map((item) => item.output),
      ['Error: Invalid arguments: property "city" must be of type string.', `Error: the arguments weren't valid JSON: {"city": "Ohr`],
    );
  });

  test("clears text written before a tool call", async () => {
    replies = [{ text: ["Let me check."], calls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Ohrid"}' }] }, { text: ["root = Card([])"] }];
    const events = await respond();
    const reset = events.findIndex((event) => event.type === "reset");
    assert.ok(reset > events.findIndex((event) => event.type === "delta"), "reset follows the discarded text");
    assert.equal(text(events.slice(reset + 1)), "root = Card([])");
  });

  test("asks for an answer after the maximum number of tool rounds", async () => {
    const lookup = (id) => ({ calls: [{ id, name: "get_weather", arguments: '{"city":"Ohrid"}' }] });
    replies = [lookup("call_1"), lookup("call_2"), lookup("call_3"), { text: ["root = Card([])"] }];
    const events = await respond();
    assert.deepEqual(
      requests.map((request) => request.body.tool_choice),
      ["auto", "auto", "auto", "none"],
    );
    assert.equal(text(events), "root = Card([])");
  });

  test("reports refusals and truncation", async () => {
    replies = [{ refusal: "I can't help with that." }];
    let events = await respond();
    assert.equal(events.at(-1).type, "refusal");

    replies = [{ text: ["root = "], status: "incomplete", reason: "content_filter" }];
    events = await respond();
    assert.equal(events.at(-1).type, "refusal");

    replies = [{ text: ["root = Card(["], status: "incomplete", reason: "max_output_tokens" }];
    events = await respond();
    assert.deepEqual(events.at(-1), { type: "done", stopReason: "max_tokens", model: "gpt-5.5-2026-04-23" });
  });

  test("turns API and stream errors into readable messages", async () => {
    replies = [{ httpStatus: 401, error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }];
    await assert.rejects(respond(), /rejected the credentials/);

    replies = [{ httpStatus: 404, error: { message: "The model does not exist", type: "invalid_request_error", code: "model_not_found" } }];
    await assert.rejects(respond(), /can't use gpt-5\.5/);

    replies = [{ events: [{ type: "error", code: "server_error", message: "The server is overloaded", sequence_number: 0 }] }];
    await assert.rejects(respond(), /overloaded/);

    replies = [{ events: [{ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "Something broke" } }, sequence_number: 0 }] }];
    await assert.rejects(respond(), /Something broke/);
  });
});
