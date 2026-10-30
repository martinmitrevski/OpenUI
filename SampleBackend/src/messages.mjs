// Chat history helpers. Messages may use the OpenUI message envelope that the app sends for
// button clicks and persisted form state:
//
//   ]]>openui:content
//   <visible text, or openui-lang for assistant messages>
//   ]]>openui:context
//   [<json>]

const CONTENT = "]]>openui:content";
const CONTEXT = "]]>openui:context";
const END = "]]>openui:end";

/** The visible text of a message: its content section without the envelope sentinels. */
export function messageText(raw) {
  let text = typeof raw === "string" ? raw : "";
  const context = text.lastIndexOf(CONTEXT);
  if (context >= 0 && context > text.lastIndexOf(CONTENT)) text = text.slice(0, context);
  const content = text.lastIndexOf(CONTENT);
  if (content >= 0) {
    const lineEnd = text.indexOf("\n", content);
    text = lineEnd >= 0 ? text.slice(lineEnd + 1) : "";
  }
  return text.replaceAll(END, "").trim();
}

/**
 * Normalizes chat history for the Messages API: keeps user/assistant turns with text, merges
 * consecutive turns with the same role and drops leading assistant turns.
 */
export function toConversation(history) {
  const conversation = [];
  for (const message of Array.isArray(history) ? history : []) {
    if (!message || typeof message.content !== "string") continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = message.content.trim();
    if (!content) continue;
    const previous = conversation.at(-1);
    if (previous?.role === message.role) previous.content += `\n\n${content}`;
    else conversation.push({ role: message.role, content });
  }
  while (conversation[0]?.role === "assistant") conversation.shift();
  return conversation;
}
