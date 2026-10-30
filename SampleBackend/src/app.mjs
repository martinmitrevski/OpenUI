// HTTP API of the sample backend.
//
//   GET  /health        -> { ok, mode, provider, model }
//   GET  /tools         -> tool specs (tools.json)
//   POST /tools/:name   -> runs a mock tool with the JSON body as arguments
//   POST /chat          -> { messages: [{ role, content }], format: "openui" | "markdown" }
//                          streams server-sent events: data: {"type": ..., ...}
//
// Chat event types: meta, status ("thinking" | "writing" | "tool"), delta (text), reset,
// fallback, done, refusal and error. See README.md.

import http from "node:http";
import { toConversation } from "./messages.mjs";
import { loadToolSpecs, tools } from "./tools.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const HEARTBEAT_MS = 10_000;

class HTTPError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp({ mode, responder, log = console.log, logMessages = false }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJSON(res, 200, { ok: true, mode, provider: responder.provider ?? null, model: responder.model ?? null });
      }
      if (req.method === "GET" && url.pathname === "/tools") {
        return sendJSON(res, 200, await loadToolSpecs());
      }
      if (req.method === "POST" && url.pathname.startsWith("/tools/")) {
        return await handleTool(req, res, toolName(url.pathname), log);
      }
      if (req.method === "POST" && url.pathname === "/chat") {
        return await handleChat(req, res, { mode, responder, log, logMessages });
      }
      sendJSON(res, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof HTTPError ? error.status : 500;
      if (status === 500) log(`error: ${error.stack ?? error}`);
      if (!res.headersSent) sendJSON(res, status, { error: error.message });
      else res.end();
    }
  });
}

function toolName(pathname) {
  try {
    return decodeURIComponent(pathname.slice("/tools/".length));
  } catch {
    throw new HTTPError(400, "Invalid tool name");
  }
}

async function handleTool(req, res, name, log) {
  const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
  if (!tool) throw new HTTPError(404, `Unknown tool "${name}"`);
  const body = await readJSON(req);
  const args = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  log(`tool ${name} ${JSON.stringify(args)}`);
  sendJSON(res, 200, await tool(args));
}

async function handleChat(req, res, { mode, responder, log, logMessages }) {
  const body = await readJSON(req);
  const messages = toConversation(body?.messages);
  if (messages.at(-1)?.role !== "user") throw new HTTPError(400, "messages must end with a user message");
  const format = body?.format === "markdown" ? "markdown" : "openui";
  log(`chat (${format}, ${messages.length} message${messages.length === 1 ? "" : "s"})`);
  if (logMessages) log(JSON.stringify(messages, null, 2));

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  let answer = "";
  const send = (event) => {
    if (logMessages) {
      if (event.type === "delta") answer += event.text;
      else if (event.type === "reset" || event.type === "refusal") answer = "";
    }
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  // Keeps the connection alive while the model thinks before its first token.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, HEARTBEAT_MS);

  try {
    send({ type: "meta", mode, format, model: responder.model ?? null });
    await responder.respond({ messages, format, send, signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) {
      log(`chat error: ${error.cause?.stack ?? error.stack ?? error}`);
      send({ type: "error", message: error.message });
    }
  } finally {
    clearInterval(heartbeat);
    if (logMessages && answer) log(`answer:\n${answer}`);
    res.end();
  }
}

async function readJSON(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HTTPError(413, "Request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HTTPError(400, "Request body must be JSON");
  }
}

function sendJSON(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
