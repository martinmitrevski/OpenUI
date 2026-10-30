# OpenUI sample backend

The backend for the demo app. It streams chat answers as OpenUI Lang or Markdown and serves the mock tools (hotels, weather, sights with photos, recipes) that generated UIs call through `Query()` and `Mutation()`. The travel content is about Ohrid, North Macedonia.

It has two modes:

- **Demo mode** answers with scripted responses from `scenarios/`, streamed in small chunks like a model would. It needs no API key and no `npm install`.
- **Live mode** streams answers from Claude (official Anthropic SDK) or an OpenAI model (official OpenAI SDK).

```sh
npm start                  # live mode if an API key is set (Anthropic first, then OpenAI), else demo mode
npm run start:demo         # always demo mode
npm run start:anthropic    # Claude (run npm install first)
npm run start:openai       # OpenAI (run npm install first)
```

`OPENUI_PROVIDER=demo|anthropic|openai` does the same as the flags.

The server listens on `http://127.0.0.1:8787`, which the iOS simulator reaches as `localhost`. To use the app on a device, start it with `HOST=0.0.0.0` and enter your Mac's address (for example `http://my-mac.local:8787`) in the app's settings. In live mode this exposes your API key's quota to your local network, so only do that on a network you trust.

## Live mode

```sh
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY=sk-...
npm start
```

Both providers work the same way:

- **Data before UI.** As the generated prompt's data workflow asks, the model can call the read-only tools (`search_hotels`, `get_weather`, `find_photos`, `scale_recipe`) on the server to see real data before it writes the UI. It then binds the UI to `Query()` with condensed real results as defaults. The write tools (`save_trip`, `add_to_shopping_list`) are only reachable through `Mutation()` buttons the user taps.
- **Photos for any place.** The prompt only allows image URLs that come from a tool or the conversation, so `find_photos` supplies them: the model passes the landmarks or dishes it wants to show, and the backend looks them up on Wikipedia (see below). Markdown answers don't get this tool, because they don't show images.
- **Same protocol.** The app can't tell the providers apart, except for the model name it shows under each answer.

### Claude

- **Model:** `claude-opus-5-5` with effort `medium`, streamed. Override with `ANTHROPIC_MODEL` and `OPENUI_EFFORT` (`low` answers faster). `OPENUI_MAX_TOKENS` defaults to 32000.
- **Refusal fallbacks are on.** Requests set `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). If Claude Opus 5.5 declines a request for policy reasons, the API retries it on Anthropic's recommended fallback model within the same stream, and the app notes which model answered. The fallback attempt is billed at the fallback model's rates. To turn this off, remove the `betas` and `fallbacks` lines in `src/anthropic.mjs`. If the whole chain declines, the app shows a refusal and discards the partial answer.
- **Prompt caching.** The generated OpenUI prompt (about 70 KB) has its own cache breakpoint, and the growing conversation is cached automatically.

### OpenAI

- **Model:** `gpt-5.5` through the Responses API, streamed, with reasoning effort `low` so the UI starts streaming sooner. Override with `OPENAI_MODEL` and `OPENAI_REASONING_EFFORT`. The effort is left out for models that don't take one, such as `gpt-4.1`.
- **Stateless.** Requests use `store: false`. Between tool rounds, the model's encrypted reasoning is passed back along with the tool results.
- **Prompt caching** is automatic: the OpenUI prompt is sent first, so repeated requests reuse it.
- **Refusals** and content filtering show up in the app as a refusal. There's no server-side fallback model; that's an Anthropic API feature.

### The system prompt

`openui/system-prompt.md` is generated from the app's Swift chat library, so the model is prompted with exactly the components and signatures the app can render. It combines:

- the chat library's components, rules and examples,
- the tools in `openui/tools.json`,
- the extra rules and tool examples in `openui/prompt-options.json`.

After changing any of these, regenerate the prompt:

```sh
scripts/export-prompt.sh
```

A unit test in the framework suite fails when the file is out of date. App-specific instructions that change per request, like today's date, are added by `src/prompts.mjs` in a separate system block after the cached prompt.

## API

| Endpoint | Description |
| --- | --- |
| `GET /health` | `{ ok, mode, model }` |
| `GET /tools` | The tool specs from `openui/tools.json` |
| `POST /tools/:name` | Runs a mock tool with the JSON body as its arguments and returns its JSON result |
| `POST /chat` | `{ messages: [{ role, content }], format: "openui" \| "markdown" }`. Streams server-sent events. |

Each chat event is a `data:` line with a JSON object:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `meta` | `mode`, `format`, `model` | Sent first, and again when the model is known |
| `status` | `status`: `thinking`, `writing` or `tool` (with `tool`) | What's happening before the text arrives |
| `delta` | `text` | The next piece of the answer |
| `reset` | | Discard the text so far (text written before a tool call) |
| `fallback` | `from`, `to` | Another model continued after a policy decline |
| `done` | `stopReason`, `model` | The answer is complete |
| `refusal` | `message` | The model declined. Discard the partial answer. |
| `error` | `message` | Something failed |

Messages may use the OpenUI message envelope: the app sends button clicks as `]]>openui:content` plus a `]]>openui:context` section with what was clicked and the form values, and persists the state of each answer's UI the same way. Demo mode routes on the visible text. Live mode passes the envelope to the model, which the prompt explains.

Set `LOG_MESSAGES=1` to log every conversation the app sends and each answer, and `DEMO_DELAY_MS` to change the demo streaming speed (default 16 ms per chunk).

## Photos

`find_photos` (in `src/photos.mjs`) looks photos up on Wikipedia while it handles the request, so it works for any place or dish, not just the demo's:

- For each topic, it takes the lead image of the best-matching English Wikipedia article, limited to freely licensed images (`pilicense=free`).
- A relevance check drops results that aren't about the topic, such as list or disambiguation pages, or "Church of St. Mark" matching a different church. Topics without a confident match are left out rather than shown with a wrong photo.
- Each photo has a `credit` line with its author and license from Wikimedia Commons, and a `pageUrl`. The demo answers show the credits or link Wikimedia Commons in their sources.
- Results are cached in memory. Set `WIKIMEDIA_USER_AGENT` to identify your deployment to Wikimedia, as their API policy asks.

The demo scenarios bind their photos with `Query("find_photos", ...)` too. That means they need internet access, and their photos appear when streaming finishes.

Hotel names, prices and forecasts from the mock tools are made up.

## Files

```
server.mjs              CLI entry point (mode selection)
src/app.mjs             HTTP API and SSE streaming
src/demo.mjs            Demo mode: routes questions to scenarios
src/live.mjs            Shared by the live providers: prompts and the read-only tools
src/anthropic.mjs       Claude: streaming, tool loop, fallbacks, refusals
src/openai.mjs          OpenAI: Responses API streaming, tool loop, refusals
src/prompts.mjs         App context and the Markdown system prompt
src/tools.mjs           Mock tools
src/messages.mjs        Envelope and history helpers
src/schema.mjs          Tool input validation
scenarios/              Scripted answers (.openui and .md)
openui/                 Tool specs, prompt options and the generated system prompt
test/                   Tests (node --test)
```

## Tests

```sh
npm install
npm test
```

The live-mode tests run against local fakes of the Anthropic Messages API and the OpenAI Responses API, so they need no API key and make no network calls. They cover the request shape, streaming, the tool loop, fallbacks, refusals and errors.
