// Demo mode: answers with scripted responses from ../scenarios, streamed in small chunks so the
// app exercises the same progressive rendering path as a live model. No API key required.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { messageText } from "./messages.mjs";
import { delay } from "./tools.mjs";

const scenariosDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scenarios");

// First match wins, so the more specific scenarios come first.
const ROUTES = [
  { scenario: "vegetarian", pattern: /\b(vegetarian|veggie|vegan|meat-?free|shakshuka)\b/i },
  {
    scenario: "hotels",
    pattern: /\b(hotels?|hostels?|accommodation|where to stay)\b|čaršija hostel|kaneo lakeview|varoš stone house|promenade boutique|gorica bay|lagadin shore|naum springs/i,
  },
  { scenario: "naum", pattern: /\b(st\.? naum|saint naum)\b/i },
  {
    scenario: "sights",
    pattern: /\b(sights?|attractions?|landmarks?|see|this place)\b|kaneo|samuel|sophia|plaošnik|plaosnik|ancient theatre|bay of bones|galičica|galicica/i,
  },
  { scenario: "weather", pattern: /\b(weather|forecast|rain|temperatures?)\b/i },
  { scenario: "recipe", pattern: /\b(recipes?|pasta|carbonara|cook|cooking)\b/i },
  { scenario: "travel", pattern: /\b(trip|travel|itinerary|plan)\b/i },
];

/** Picks the scenario for a user message; `fallback` when nothing matches. */
export function routeScenario(text) {
  return ROUTES.find((route) => route.pattern.test(text))?.scenario ?? "fallback";
}

/** Loads a scenario in the requested format, filling in the `{{topic}}` placeholder. */
export async function loadScenario(name, format, topic) {
  const extension = format === "markdown" ? "md" : "openui";
  const template = await readFile(path.join(scenariosDir, `${name}.${extension}`), "utf8");
  const title = topic.replace(/\s+/g, " ").trim().slice(0, 80) || "Hello!";
  // OpenUI Lang string literals use JSON escaping.
  return template.replaceAll("{{topic}}", format === "markdown" ? title : JSON.stringify(title));
}

export function createDemoResponder({ chunkDelayMs = Number(process.env.DEMO_DELAY_MS ?? 16) } = {}) {
  return {
    model: null,
    async respond({ messages, format, send, signal }) {
      const question = messageText(messages.at(-1)?.content);
      const scenario = routeScenario(question);
      const text = await loadScenario(scenario, format, question);
      send({ type: "status", status: "thinking" });
      await delay(Math.min(400, chunkDelayMs * 25));
      send({ type: "status", status: "writing" });
      // Split by code point so multi-unit characters never straddle two chunks.
      const characters = Array.from(text);
      for (let index = 0; index < characters.length && !signal.aborted; ) {
        const size = 8 + Math.floor(Math.random() * 9);
        send({ type: "delta", text: characters.slice(index, index + size).join("") });
        index += size;
        if (chunkDelayMs > 0) await delay(chunkDelayMs);
      }
      if (!signal.aborted) send({ type: "done", stopReason: "end_turn", scenario });
    },
  };
}
