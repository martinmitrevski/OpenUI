#!/usr/bin/env node
// OpenUI sample backend.
//
//   node server.mjs              live answers if an API key is set (Anthropic first, then OpenAI), else demo mode
//   node server.mjs --demo       scripted answers, no API key needed
//   node server.mjs --anthropic  live answers from Claude (run `npm install` first)
//   node server.mjs --openai     live answers from an OpenAI model (run `npm install` first)
//
// Environment: PORT (8787), HOST (127.0.0.1; use 0.0.0.0 to reach it from a device),
// OPENUI_PROVIDER (demo | anthropic | openai), ANTHROPIC_MODEL, OPENUI_EFFORT, OPENUI_MAX_TOKENS,
// OPENAI_MODEL, OPENAI_REASONING_EFFORT, OPENAI_BASE_URL, DEMO_DELAY_MS,
// LOG_MESSAGES=1 (log each conversation and answer).

import { createApp } from "./src/app.mjs";
import { createDemoResponder } from "./src/demo.mjs";

const PROVIDERS = ["demo", "anthropic", "openai"];
const args = new Set(process.argv.slice(2));
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

/** The live provider whose API key is set, preferring Anthropic. */
function providerWithKey() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

function resolveProvider() {
  const flag = PROVIDERS.find((provider) => args.has(`--${provider}`));
  if (flag) return flag;
  if (PROVIDERS.includes(process.env.OPENUI_PROVIDER)) return process.env.OPENUI_PROVIDER;
  return providerWithKey() ?? "demo";
}

const log = (message) => console.log(`[${new Date().toLocaleTimeString("en-GB")}] ${message}`);

async function createResponder(provider) {
  if (provider === "demo") return createDemoResponder();
  try {
    if (provider === "openai") {
      const { createOpenAIResponder } = await import("./src/openai.mjs");
      return await createOpenAIResponder({ log });
    }
    const { createAnthropicResponder } = await import("./src/anthropic.mjs");
    return await createAnthropicResponder({ log });
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") {
      console.error("Live mode needs the provider SDKs. Run `npm install` in SampleBackend first.");
      process.exit(1);
    }
    throw error;
  }
}

const provider = resolveProvider();
const responder = await createResponder(provider);
const server = createApp({
  mode: provider === "demo" ? "demo" : "llm",
  responder,
  log,
  logMessages: process.env.LOG_MESSAGES === "1",
});

server.listen(port, host, () => {
  const detail = provider === "demo" ? "demo, scripted answers" : `live, ${responder.model}`;
  console.log(`OpenUI sample backend (${detail}) listening on http://${host}:${port}`);
});
