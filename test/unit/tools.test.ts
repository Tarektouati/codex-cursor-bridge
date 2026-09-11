import assert from "node:assert/strict";
import test from "node:test";

import { buildCustomTools, freeformPayload } from "../../src/translate/tools.js";
import type { CodexTool } from "../../src/translate/responses-types.js";

const noop = async (): Promise<string> => "";

test("function tools keep their JSON Schema parameters", () => {
  const params = {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  };
  const { customTools, kinds } = buildCustomTools(
    [{ type: "function", name: "exec_command", description: "run it", parameters: params }],
    noop,
  );
  assert.equal(kinds.get("exec_command"), "function");
  assert.deepEqual(customTools.exec_command?.inputSchema, params);
  assert.equal(customTools.exec_command?.description, "run it");
});

test("freeform tools become a single input string", () => {
  // Cursor's inputSchema is JSON Schema only, so a lark-grammar tool cannot be
  // represented faithfully; it is modelled as one raw string instead.
  const { customTools, kinds } = buildCustomTools(
    [
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply a patch",
        format: { type: "grammar", syntax: "lark", definition: "start: ..." },
      },
    ],
    noop,
  );
  assert.equal(kinds.get("apply_patch"), "freeform");
  assert.deepEqual(customTools.apply_patch?.inputSchema, {
    type: "object",
    properties: {
      input: {
        type: "string",
        description:
          "The complete raw payload for this tool, passed through verbatim.",
      },
    },
    required: ["input"],
  });
  assert.match(String(customTools.apply_patch?.description), /input.*string/);
});

test("namespace tools are flattened to their children", () => {
  const { customTools, kinds } = buildCustomTools(
    [
      {
        type: "namespace",
        name: "mcp__node_repl",
        tools: [
          { type: "function", name: "js", parameters: { type: "object", properties: {} } },
          { type: "function", name: "js_reset", parameters: { type: "object", properties: {} } },
        ],
      },
    ],
    noop,
  );
  assert.deepEqual([...kinds.keys()].sort(), ["js", "js_reset"]);
  assert.ok(customTools.js);
  assert.ok(!customTools.mcp__node_repl);
});

test("tools with no callable name are skipped, not crashed on", () => {
  const tools: CodexTool[] = [
    { type: "web_search" },
    { type: "image_generation" },
    { type: "function", name: "view_image", parameters: { type: "object", properties: {} } },
  ];
  const { customTools, kinds, skipped } = buildCustomTools(tools, noop);
  assert.deepEqual([...kinds.keys()], ["view_image"]);
  assert.equal(Object.keys(customTools).length, 1);
  assert.equal(skipped.length, 2);
});

test("function tools without parameters get an empty object schema", () => {
  const { customTools } = buildCustomTools(
    [{ type: "function", name: "get_goal" }],
    noop,
  );
  assert.deepEqual(customTools.get_goal?.inputSchema, {
    type: "object",
    properties: {},
  });
});

test("execute forwards the call id supplied by the SDK", async () => {
  const seen: Array<{ name: string; callId: string }> = [];
  const { customTools } = buildCustomTools(
    [{ type: "function", name: "exec_command", parameters: { type: "object", properties: {} } }],
    async (req) => {
      seen.push({ name: req.name, callId: req.callId });
      return "output";
    },
  );
  const result = await customTools.exec_command?.execute(
    { command: "ls" },
    { toolCallId: "tool_abc" },
  );
  assert.equal(result, "output");
  assert.deepEqual(seen, [{ name: "exec_command", callId: "tool_abc" }]);
});

test("freeformPayload unwraps the input string", () => {
  assert.equal(freeformPayload({ input: "*** Begin Patch" }), "*** Begin Patch");
  assert.equal(freeformPayload({ patch: "other key" }), "other key");
  assert.equal(freeformPayload({ a: "1", b: "2" }), '{"a":"1","b":"2"}');
});
