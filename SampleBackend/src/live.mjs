// Shared by the live providers: the system prompts and the read-only tools the model can call to
// inspect real data before it writes its answer (the "data workflow" in the generated OpenUI
// prompt). Write tools are only reachable through Mutation() buttons in the generated UI.

import { loadOpenUIPrompt, markdownPrompt, openUIAppContext } from "./prompts.mjs";
import { validateInput } from "./schema.mjs";
import { loadToolSpecs, tools as toolImplementations } from "./tools.mjs";

/** Tool rounds before the model is asked to answer with the data it has. */
export const MAX_TOOL_ROUNDS = 3;
/** Markdown answers don't show images, so the model doesn't get the photo tool there. */
const OPENUI_ONLY_TOOLS = new Set(["find_photos"]);

export async function loadLiveSetup() {
  const [openUIPrompt, toolSpecs] = await Promise.all([loadOpenUIPrompt(), loadToolSpecs()]);
  const allReadSpecs = toolSpecs.filter((spec) => spec.annotations?.readOnlyHint === true);
  const writeTools = toolSpecs.filter((spec) => !allReadSpecs.includes(spec)).map((spec) => spec.name);
  const specsByName = new Map(allReadSpecs.map((spec) => [spec.name, spec]));
  const readSpecs = (format) =>
    format === "markdown" ? allReadSpecs.filter((spec) => !OPENUI_ONLY_TOOLS.has(spec.name)) : allReadSpecs;

  return {
    /** Specs of the tools the model can call when answering in `format`. */
    readSpecs,

    /**
     * The system prompt in two parts: `prefix` is identical for every request (worth caching;
     * `null` for Markdown), `context` holds the per-request app instructions such as the date.
     */
    systemPrompts(format, now = new Date()) {
      const readTools = readSpecs(format).map((spec) => spec.name);
      return format === "markdown"
        ? { prefix: null, context: markdownPrompt({ readTools, now }) }
        : { prefix: openUIPrompt, context: openUIAppContext({ readTools, writeTools, now }) };
    },

    /**
     * Runs a read-only tool for the model. Returns `{ ok: true, content }` with the JSON result, or
     * `{ ok: false, reason, message }` where reason is "unknown", "invalid" or "failed".
     */
    async runTool(name, input) {
      const spec = specsByName.get(name);
      if (!spec) return { ok: false, reason: "unknown", message: `Unknown tool "${name}".` };
      const problem = validateInput(spec.inputSchema, input);
      if (problem) return { ok: false, reason: "invalid", message: `Invalid arguments: ${problem}.` };
      try {
        return { ok: true, content: JSON.stringify(await toolImplementations[name](input)) };
      } catch (error) {
        return { ok: false, reason: "failed", message: String(error?.message ?? error) };
      }
    },
  };
}
