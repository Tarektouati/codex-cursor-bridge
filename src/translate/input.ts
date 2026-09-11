import type { ResponseItem, ResponsesRequest } from "./responses-types.js";

export interface ToolOutput {
  callId: string;
  output: string;
}

function itemType(item: ResponseItem): string {
  return typeof item.type === "string" ? item.type : "";
}

function normalizeInput(input: ResponsesRequest["input"]): ResponseItem[] {
  if (!input) {
    return [];
  }
  if (typeof input === "string") {
    return [
      { type: "message", role: "user", content: [{ type: "input_text", text: input }] },
    ];
  }
  return input;
}

/**
 * Codex's `function_call_output.output` is either a bare string or an array of
 * content items. Flatten both to text, since Cursor's custom tools return text.
 */
function flattenOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    return output
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (output && typeof output === "object") {
    const maybe = output as { output?: unknown; content?: unknown };
    if (typeof maybe.output === "string") {
      return maybe.output;
    }
    if (maybe.content !== undefined) {
      return flattenOutput(maybe.content);
    }
  }
  return output === undefined || output === null ? "" : JSON.stringify(output);
}

/** Every tool result present in the request, in order. */
export function extractToolOutputs(
  input: ResponsesRequest["input"],
): ToolOutput[] {
  const results: ToolOutput[] = [];
  for (const item of normalizeInput(input)) {
    const type = itemType(item);
    if (type !== "function_call_output" && type !== "custom_tool_call_output") {
      continue;
    }
    const callId = (item as { call_id?: unknown }).call_id;
    if (typeof callId !== "string") {
      continue;
    }
    results.push({
      callId,
      output: flattenOutput((item as { output?: unknown }).output),
    });
  }
  return results;
}

function textOf(item: ResponseItem): string {
  const content = (item as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object") {
        const p = part as { type?: string; text?: unknown };
        if (typeof p.text === "string") {
          return p.text;
        }
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

/**
 * The user text that is new in this request.
 *
 * Codex is stateless and resends the whole conversation every turn, but the
 * Cursor agent keeps its own history, so replaying everything would duplicate
 * it. Anything after the last assistant or tool item is what's new; if there is
 * no such boundary this is the first turn and all user text counts.
 */
export function extractNewUserText(input: ResponsesRequest["input"]): string {
  const items = normalizeInput(input);
  let boundary = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item) {
      continue;
    }
    const type = itemType(item);
    const role = (item as { role?: unknown }).role;
    const isAssistantTurn =
      type === "function_call" ||
      type === "custom_tool_call" ||
      type === "function_call_output" ||
      type === "custom_tool_call_output" ||
      (type === "message" && role === "assistant");
    if (isAssistantTurn) {
      boundary = i;
      break;
    }
  }

  const parts: string[] = [];
  for (let i = boundary + 1; i < items.length; i += 1) {
    const item = items[i];
    if (!item || itemType(item) !== "message") {
      continue;
    }
    const role = (item as { role?: unknown }).role;
    if (role === "assistant") {
      continue;
    }
    const text = textOf(item);
    if (text.trim()) {
      parts.push(text);
    }
  }
  return parts.join("\n\n");
}

/**
 * Codex advertises its working directory inside an environment context block.
 * Reading it lets the Cursor agent share the same workspace scope.
 */
export function extractCwd(input: ResponsesRequest["input"]): string | undefined {
  for (const item of normalizeInput(input)) {
    const text = textOf(item);
    const match = /<cwd>([^<]+)<\/cwd>/.exec(text);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

/**
 * Cursor's own harness prompt cannot be removed without the account-gated
 * `systemPrompt` option, so Codex's instructions are delivered as the opening
 * user message instead. The preamble tells the model to disregard the tool
 * vocabulary Cursor's prompt advertises, since every built-in tool is gone and
 * only Codex's bridged tools remain.
 */
export function buildPreamble(toolNames: string[]): string {
  const list = toolNames.length > 0 ? toolNames.join(", ") : "(none)";
  return [
    "You are running as the backend for an external coding harness.",
    "Ignore any earlier instructions about your own built-in tools: they are",
    "all disabled. The only tools you can call are provided by the harness and",
    `are named: ${list}.`,
    "You cannot read or edit files yourself; use those tools instead.",
    "The harness's operating instructions follow and take precedence.",
  ].join(" ");
}

/**
 * Recovery path for when Codex sends tool results the bridge has no live run
 * for, which happens if the bridge restarted or reaped the session mid-task.
 * Since Codex resends the whole conversation, the transcript can be rendered
 * as plain text and replayed as one prompt to re-establish context.
 */
export function buildReplayPrompt(input: ResponsesRequest["input"]): string {
  const lines: string[] = [
    "The connection to your previous run was lost. Here is the conversation so",
    "far, including tool calls you made and their results. Continue from where",
    "it left off.",
    "",
  ];
  for (const item of normalizeInput(input)) {
    const type = itemType(item);
    const role = (item as { role?: unknown }).role;
    if (type === "message") {
      const text = textOf(item);
      if (text.trim()) {
        lines.push(`[${role === "assistant" ? "assistant" : "user"}] ${text.trim()}`);
      }
    } else if (type === "function_call" || type === "custom_tool_call") {
      const name = (item as { name?: unknown }).name;
      const payload =
        (item as { arguments?: unknown }).arguments ??
        (item as { input?: unknown }).input ??
        "";
      lines.push(`[tool call] ${String(name)} ${String(payload)}`);
    } else if (
      type === "function_call_output" ||
      type === "custom_tool_call_output"
    ) {
      lines.push(`[tool result] ${flattenOutput((item as { output?: unknown }).output)}`);
    }
  }
  return lines.join("\n");
}

export function buildFirstPrompt(
  instructions: string | undefined,
  userText: string,
  toolNames: string[],
): string {
  const sections = [buildPreamble(toolNames)];
  if (instructions?.trim()) {
    sections.push(
      `<harness_instructions>\n${instructions.trim()}\n</harness_instructions>`,
    );
  }
  if (userText.trim()) {
    sections.push(`<user_request>\n${userText.trim()}\n</user_request>`);
  }
  return sections.join("\n\n");
}
