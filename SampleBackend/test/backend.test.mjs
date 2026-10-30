import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { createApp } from "../src/app.mjs";
import { createDemoResponder, loadScenario, routeScenario } from "../src/demo.mjs";
import { messageText, toConversation } from "../src/messages.mjs";
import { validateInput } from "../src/schema.mjs";

const scenarioFile = (name) => new URL(`../scenarios/${name}`, import.meta.url);

/** Parses a server-sent event stream body into its JSON events. */
export function parseEvents(body) {
  return body
    .split("\n\n")
    .map((chunk) => chunk.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

describe("messages", () => {
  test("messageText strips the OpenUI envelope", () => {
    assert.equal(messageText("Plan a trip"), "Plan a trip");
    assert.equal(
      messageText(']]>openui:content\nFind hotels in Ohrid under €70\n]]>openui:context\n["User clicked: Find hotels in Ohrid under €70"]'),
      "Find hotels in Ohrid under €70",
    );
    assert.equal(messageText(']]>openui:context\n["User clicked: x"]'), "");
    assert.equal(messageText("root = Card([])\n]]>openui:end"), "root = Card([])");
    assert.equal(messageText(undefined), "");
  });

  test("toConversation keeps valid turns, merges same-role turns and starts with the user", () => {
    const conversation = toConversation([
      { role: "assistant", content: "Welcome!" },
      { role: "user", content: " Hi " },
      { role: "user", content: "Plan a trip" },
      { role: "system", content: "ignored" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "root = Card([])" },
      { role: "user", content: 42 },
      null,
      { role: "user", content: "Thanks" },
    ]);
    assert.deepEqual(conversation, [
      { role: "user", content: "Hi\n\nPlan a trip" },
      { role: "assistant", content: "root = Card([])" },
      { role: "user", content: "Thanks" },
    ]);
    assert.deepEqual(toConversation("nope"), []);
  });
});

describe("demo scenarios", () => {
  test("routes the suggested questions to their scenarios", () => {
    const expectations = {
      "Plan a 3-day trip to Ohrid": "travel",
      "Find hotels in Ohrid under €70": "hotels",
      "What's the weather like next week?": "weather",
      "Give me a quick pasta recipe": "recipe",
      "Make it vegetarian": "vegetarian",
      "Show me the carbonara recipe again": "recipe",
      "Plan the St. Naum day trip in detail": "naum",
      "Show me the top sights in Ohrid": "sights",
      "Tell me more about this place in Ohrid": "sights",
      "Is Samuel's Fortress worth visiting?": "sights",
      "Tell me more about Naum Springs Lodge": "hotels",
      "Where can I rent a kayak in Ohrid?": "fallback",
    };
    for (const [question, scenario] of Object.entries(expectations)) {
      assert.equal(routeScenario(question), scenario, question);
    }
  });

  test("fills the fallback topic as an escaped OpenUI string", async () => {
    const program = await loadScenario("fallback", "openui", 'Say "hi"\nplease');
    assert.match(program, /header = CardHeader\("Say \\"hi\\" please", "Demo mode"\)/);
    const markdown = await loadScenario("fallback", "markdown", "Tram tips");
    assert.match(markdown, /^## Tram tips$/m);
  });
});

describe("validateInput", () => {
  const schema = {
    type: "object",
    properties: { city: { type: "string" }, maxPrice: { type: "number" }, sort: { type: "string", enum: ["price", "rating"] } },
    required: ["city"],
  };

  test("accepts matching input", () => {
    assert.equal(validateInput(schema, { city: "Ohrid" }), null);
    assert.equal(validateInput(schema, { city: "Ohrid", maxPrice: 120, sort: "rating", extra: true }), null);
  });

  test("reports the first problem", () => {
    assert.equal(validateInput(schema, null), "input must be an object");
    assert.equal(validateInput(schema, []), "input must be an object");
    assert.equal(validateInput(schema, {}), 'missing required property "city"');
    assert.equal(validateInput(schema, { city: 1 }), 'property "city" must be of type string');
    assert.equal(validateInput(schema, { city: "x", maxPrice: "100" }), 'property "maxPrice" must be of type number');
    assert.equal(validateInput(schema, { city: "x", sort: "name" }), 'property "sort" must be one of "price", "rating"');
    assert.equal(validateInput({ ...schema, additionalProperties: false }, { city: "x", extra: 1 }), 'unexpected property "extra"');
  });
});

describe("HTTP API (demo mode)", () => {
  let server;
  let baseURL;

  before(async () => {
    server = createApp({ mode: "demo", responder: createDemoResponder({ chunkDelayMs: 0 }), log: () => {} });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  const post = (path, body) =>
    fetch(baseURL + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  test("GET /health", async () => {
    const response = await fetch(`${baseURL}/health`);
    assert.deepEqual(await response.json(), { ok: true, mode: "demo", provider: null, model: null });
  });

  test("GET /tools lists the tool specs", async () => {
    const tools = await (await fetch(`${baseURL}/tools`)).json();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["search_hotels", "get_weather", "find_photos", "scale_recipe", "save_trip", "add_to_shopping_list"],
    );
  });

  test("POST /tools/:name runs a tool with the JSON body", async () => {
    const response = await post("/tools/search_hotels", { city: "Ohrid", maxPrice: "70", sort: "price" });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.total, 3);
    assert.deepEqual(
      result.hotels.map((hotel) => hotel.price),
      [19, 54, 68],
    );

    const recipe = await (await post("/tools/scale_recipe", { recipe: "carbonara", servings: "4" })).json();
    assert.equal(recipe.servings, 4);
    assert.deepEqual(recipe.ingredients[0], { item: "Spaghetti", amount: "400 g" });
  });

  test("POST /tools rejects unknown tools", async () => {
    for (const name of ["nope", "constructor", "__proto__"]) {
      const response = await post(`/tools/${name}`, {});
      assert.equal(response.status, 404, name);
    }
    assert.equal((await post("/tools/%E0%A4%A", {})).status, 400);
  });

  test("POST /chat streams the scenario as OpenUI Lang", async () => {
    const response = await post("/chat", { messages: [{ role: "user", content: "Plan a 3-day trip to Ohrid" }] });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    const events = parseEvents(await response.text());
    assert.deepEqual(events[0], { type: "meta", mode: "demo", format: "openui", model: null });
    assert.deepEqual(events.at(-1), { type: "done", stopReason: "end_turn", scenario: "travel" });
    const text = events.filter((event) => event.type === "delta").map((event) => event.text).join("");
    assert.equal(text, await readFile(scenarioFile("travel.openui"), "utf8"));
  });

  test("POST /chat streams Markdown and reads action envelopes", async () => {
    const action = ']]>openui:content\nFind hotels in Ohrid under €70\n]]>openui:context\n["User clicked: Find hotels in Ohrid under €70"]';
    const response = await post("/chat", {
      format: "markdown",
      messages: [
        { role: "user", content: "Plan a trip" },
        { role: "assistant", content: "root = Card([])" },
        { role: "user", content: action },
      ],
    });
    const events = parseEvents(await response.text());
    const text = events.filter((event) => event.type === "delta").map((event) => event.text).join("");
    assert.equal(text, await readFile(scenarioFile("hotels.md"), "utf8"));
  });

  test("POST /chat validates the request", async () => {
    assert.equal((await post("/chat", { messages: [] })).status, 400);
    assert.equal((await post("/chat", { messages: [{ role: "assistant", content: "hi" }] })).status, 400);
    const invalid = await fetch(`${baseURL}/chat`, { method: "POST", body: "{nope" });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "Request body must be JSON" });
  });

  test("unknown routes return 404", async () => {
    assert.equal((await fetch(`${baseURL}/nope`)).status, 404);
  });
});
