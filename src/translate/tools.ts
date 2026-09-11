import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";

import { log } from "../log.js";
import type { CodexTool } from "./responses-types.js";

/**
 * Codex serializes tools two ways, and they round-trip differently:
 *  - `function` tools take a JSON object and come back as `function_call`
 *    items whose `arguments` is a JSON-encoded string.
 *  - `custom` (freeform/grammar) tools take one raw string and come back as
 *    `custom_tool_call` items with an `input` string.
 * Cursor's `SDKCustomTool.inputSchema` is JSON Schema only, so freeform tools
 * are modelled as a single required `input` string and unwrapped on the way out.
 */
export type ToolKind = "function" | "freeform";

export interface ToolCallRequest {
  name: string;
  kind: ToolKind;
  callId: string;
  args: Record<string, SDKJsonValue>;
}

/** Called when the Cursor model invokes a bridged tool. Resolves to the output Codex returns. */
export type ToolCallDispatcher = (req: ToolCallRequest) => Promise<string>;

const FREEFORM_SCHEMA: Record<string, SDKJsonValue> = {
  type: "object",
  properties: {
    input: {
      type: "string",
      description:
        "The complete raw payload for this tool, passed through verbatim.",
    },
  },
  required: ["input"],
};

/** Tool types that carry no callable name for us to bridge. */
const UNBRIDGEABLE = new Set([
  "web_search",
  "web_search_preview",
  "image_generation",
  "tool_search",
  "local_shell",
  "computer_use_preview",
]);

export interface BridgedTools {
  customTools: Record<string, SDKCustomTool>;
  kinds: Map<string, ToolKind>;
  skipped: string[];
}

export function buildCustomTools(
  tools: CodexTool[] | undefined,
  dispatch: ToolCallDispatcher,
): BridgedTools {
  const customTools: Record<string, SDKCustomTool> = {};
  const kinds = new Map<string, ToolKind>();
  const skipped: string[] = [];

  const add = (tool: CodexTool): void => {
    const type = String(tool.type ?? "");

    if (type === "namespace") {
      // Namespaced tools are a presentation container; the model still calls
      // the inner names, so flatten one level.
      const inner = (tool as { tools?: CodexTool[] }).tools ?? [];
      for (const child of inner) {
        add(child);
      }
      return;
    }

    const name = typeof tool.name === "string" ? tool.name : "";
    if (!name) {
      skipped.push(type || "<unnamed>");
      return;
    }
    if (UNBRIDGEABLE.has(type) || UNBRIDGEABLE.has(name)) {
      skipped.push(name);
      return;
    }

    const kind: ToolKind = type === "custom" ? "freeform" : "function";
    const description =
      typeof tool.description === "string" ? tool.description : undefined;

    const schema =
      kind === "freeform"
        ? FREEFORM_SCHEMA
        : ((tool as { parameters?: Record<string, SDKJsonValue> }).parameters ??
          { type: "object", properties: {} });

    kinds.set(name, kind);
    customTools[name] = {
      ...(description
        ? {
            description:
              kind === "freeform"
                ? `${description}\n\nPass the entire payload as the "input" string.`
                : description,
          }
        : {}),
      inputSchema: schema,
      execute: async (args, context) => {
        const callId = context.toolCallId ?? `bridge_${name}_${Date.now()}`;
        return dispatch({ name, kind, callId, args });
      },
    };
  };

  for (const tool of tools ?? []) {
    add(tool);
  }

  if (skipped.length > 0) {
    log.debug("skipped unbridgeable tools", { tools: skipped.join(",") });
  }
  return { customTools, kinds, skipped };
}

/**
 * Freeform tools receive `{ input: "..." }` but must be emitted as a raw
 * string. Tolerate a model that puts the payload under another single key.
 */
export function freeformPayload(args: Record<string, SDKJsonValue>): string {
  const direct = args.input;
  if (typeof direct === "string") {
    return direct;
  }
  const values = Object.values(args);
  if (values.length === 1 && typeof values[0] === "string") {
    return values[0];
  }
  return JSON.stringify(args);
}
