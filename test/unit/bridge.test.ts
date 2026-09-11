import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { SDKAgent, SDKCustomTool } from "@cursor/sdk";

import type { BridgeConfig } from "../../src/config.js";
import { setLogLevel } from "../../src/log.js";
import { createBridgeServer } from "../../src/server.js";
import { SessionManager, type AgentFactory } from "../../src/session.js";
import type { ResponseItem } from "../../src/translate/responses-types.js";

setLogLevel("error");

const config: BridgeConfig = {
  host: "127.0.0.1",
  port: 0,
  cursorApiKey: "test-key",
  bridgeKey: undefined,
  defaultCwd: "/tmp",
  defaultModel: "composer-2.5",
  toolBatchWindowMs: 10,
  sessionIdleMs: 60_000,
  streamThinking: true,
  logLevel: "error",
};

/**
 * What a stubbed Cursor run does. `callTool` parks exactly like the real SDK's
 * `execute()` does, which is the behaviour the bridge depends on.
 */
type Script = (ctx: {
  prompt: string;
  emitText: (text: string) => void;
  emitThinking: (text: string) => void;
  callTool: (name: string, args: Record<string, unknown>, callId: string) => Promise<string>;
}) => Promise<string>;

interface StubHandle {
  factory: AgentFactory;
  prompts: string[];
  toolNames: () => string[];
}

function stubAgent(scripts: Script[]): StubHandle {
  const prompts: string[] = [];
  let latestTools: Record<string, SDKCustomTool> = {};
  let sendCount = 0;

  const factory: AgentFactory = async () => {
    const agent = {
      agentId: "agent-stub",
      async send(
        message: string,
        options?: {
          onDelta?: (args: { update: { type: string; text?: string } }) => void;
          local?: { customTools?: Record<string, SDKCustomTool> };
        },
      ) {
        prompts.push(message);
        if (options?.local?.customTools) {
          latestTools = options.local.customTools;
        }
        const script = scripts[sendCount] ?? scripts[scripts.length - 1];
        sendCount += 1;

        let settle!: (value: {
          status: string;
          result?: string;
          id: string;
          error?: { message: string };
        }) => void;
        const done = new Promise<{
          status: string;
          result?: string;
          id: string;
          error?: { message: string };
        }>((resolve) => {
          settle = resolve;
        });

        const emit = (type: string, text: string) =>
          options?.onDelta?.({ update: { type, text } });

        void (async () => {
          try {
            const final = await script!({
              prompt: message,
              emitText: (text) => emit("text-delta", text),
              emitThinking: (text) => emit("thinking-delta", text),
              callTool: async (name, args, callId) => {
                const tool = latestTools[name];
                if (!tool) {
                  throw new Error(`stub: no such tool ${name}`);
                }
                const result = await tool.execute(
                  args as Parameters<SDKCustomTool["execute"]>[0],
                  { toolCallId: callId },
                );
                return String(result);
              },
            });
            settle({ status: "finished", result: final, id: "run-stub" });
          } catch (err) {
            // The real SDK surfaces a mid-run failure as RunResult.status
            // "error", not a thrown send(); mirror that so the bridge takes its
            // failure path instead of hanging on an unsettled wait().
            settle({
              status: "error",
              id: "run-stub",
              error: { message: err instanceof Error ? err.message : String(err) },
            });
          }
        })();

        let status = "running";
        void done.then((r) => {
          status = r.status;
        });
        return {
          id: "run-stub",
          agentId: "agent-stub",
          get status() {
            return status;
          },
          // eslint-disable-next-line require-yield
          async *stream() {
            await done;
          },
          wait: () => done,
          cancel: async () => {
            status = "cancelled";
          },
          supports: () => true,
        };
      },
      async [Symbol.asyncDispose]() {},
    };
    return agent as unknown as SDKAgent;
  };

  return { factory, prompts, toolNames: () => Object.keys(latestTools) };
}

interface Frames {
  all: Array<Record<string, unknown>>;
  types: string[];
  text: string;
  doneItems: ResponseItem[];
  completed: Record<string, unknown> | undefined;
  failed: Record<string, unknown> | undefined;
}

async function withBridge(
  scripts: Script[],
  fn: (
    post: (body: unknown) => Promise<Frames>,
    handle: StubHandle,
  ) => Promise<void>,
): Promise<void> {
  const handle = stubAgent(scripts);
  const manager = new SessionManager(config, handle.factory);
  const server = createBridgeServer(config, manager);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const post = async (body: unknown): Promise<Frames> => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const raw = await res.text();
    const frames = raw
      .split("\n\n")
      .map((block) => block.split("\n").find((l) => l.startsWith("data:")))
      .filter((l): l is string => Boolean(l))
      .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>);

    return {
      all: frames,
      types: frames.map((f) => String(f.type)),
      text: frames
        .filter((f) => f.type === "response.output_text.delta")
        .map((f) => String(f.delta))
        .join(""),
      doneItems: frames
        .filter((f) => f.type === "response.output_item.done")
        .map((f) => f.item as ResponseItem),
      completed: frames.find((f) => f.type === "response.completed"),
      failed: frames.find((f) => f.type === "response.failed"),
    };
  };

  try {
    await fn(post, handle);
  } finally {
    await manager.shutdown().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const userTurn = (text: string, tools: unknown[] = []) => ({
  model: "composer-2.5",
  instructions: "HARNESS RULES",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
  tools,
  stream: true,
  store: false,
  prompt_cache_key: "test-thread",
});

const EXEC_TOOL = {
  type: "function",
  name: "exec_command",
  description: "run a command",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};

test("a text turn emits the frame sequence Codex requires", async () => {
  await withBridge(
    [
      async ({ emitText }) => {
        emitText("Hello");
        emitText(" world");
        return "Hello world";
      },
    ],
    async (post) => {
      const frames = await post(userTurn("say hello"));

      assert.deepEqual(frames.types, [
        "response.created",
        "response.output_item.added",
        "response.output_text.delta",
        "response.output_text.delta",
        "response.output_item.done",
        "response.completed",
      ]);
      assert.equal(frames.text, "Hello world");

      // Codex parses `response.id` as a required String; a missing one turns a
      // good turn into "failed to parse ResponseCompleted".
      const response = frames.completed?.response as { id?: unknown; usage?: unknown };
      assert.equal(typeof response.id, "string");
      assert.ok(String(response.id).length > 0);

      // Usage is all-or-nothing in Codex's parser, so the bridge omits it.
      assert.equal(response.usage, undefined);

      assert.deepEqual(frames.doneItems, [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello world" }],
        },
      ]);
    },
  );
});

test("thinking deltas become reasoning summary deltas", async () => {
  await withBridge(
    [
      async ({ emitThinking, emitText }) => {
        emitThinking("pondering");
        emitText("answer");
        return "answer";
      },
    ],
    async (post) => {
      const frames = await post(userTurn("think"));
      assert.ok(frames.types.includes("response.reasoning_summary_part.added"));
      const delta = frames.all.find(
        (f) => f.type === "response.reasoning_summary_text.delta",
      );
      // Codex drops a reasoning delta that has no summary_index.
      assert.equal(delta?.summary_index, 0);
      assert.equal(delta?.delta, "pondering");
    },
  );
});

test("the first prompt carries instructions and bridged tool names", async () => {
  await withBridge(
    [
      async () => "ok",
    ],
    async (post, handle) => {
      await post(userTurn("do it", [EXEC_TOOL]));
      const prompt = handle.prompts[0] ?? "";
      assert.match(prompt, /HARNESS RULES/);
      assert.match(prompt, /exec_command/);
      assert.match(prompt, /<user_request>\ndo it\n<\/user_request>/);
      assert.deepEqual(handle.toolNames(), ["exec_command"]);
    },
  );
});

test("a tool call ends the turn and the result resumes the same run", async () => {
  let toolOutput = "";
  await withBridge(
    [
      async ({ callTool, emitText }) => {
        // Parks until the second HTTP request delivers the output.
        toolOutput = await callTool("exec_command", { command: "ls" }, "tool_1");
        emitText("file created");
        return "file created";
      },
    ],
    async (post, handle) => {
      const first = await post(userTurn("create a file", [EXEC_TOOL]));

      // No function_call_arguments.* frames: Codex 0.140 ignores them entirely,
      // so the call must arrive as a single completed item.
      assert.ok(
        !first.types.some((t) => t.includes("function_call_arguments")),
        "must not emit function_call_arguments frames",
      );
      assert.equal(first.completed?.type, "response.completed");

      assert.deepEqual(first.doneItems, [
        {
          type: "function_call",
          name: "exec_command",
          arguments: '{"command":"ls"}',
          call_id: "tool_1",
        },
      ]);

      // Codex is stateless: it resends the whole transcript plus the output.
      const second = await post({
        ...userTurn("create a file", [EXEC_TOOL]),
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "create a file" }],
          },
          {
            type: "function_call",
            name: "exec_command",
            arguments: '{"command":"ls"}',
            call_id: "tool_1",
          },
          { type: "function_call_output", call_id: "tool_1", output: "ok.txt" },
        ],
      });

      assert.equal(toolOutput, "ok.txt", "tool promise resolved with Codex's output");
      assert.equal(second.text, "file created");
      assert.equal(second.completed?.type, "response.completed");

      // One send() only: the second request continued the existing run rather
      // than starting a new one, so history is never replayed.
      assert.equal(handle.prompts.length, 1);
    },
  );
});

test("parallel tool calls are emitted as one batch, not one per turn", async () => {
  await withBridge(
    [
      async ({ callTool, emitText }) => {
        const [a, b] = await Promise.all([
          callTool("exec_command", { command: "one" }, "tool_a"),
          callTool("exec_command", { command: "two" }, "tool_b"),
        ]);
        emitText(`${a}+${b}`);
        return `${a}+${b}`;
      },
    ],
    async (post) => {
      const first = await post(userTurn("do two things", [EXEC_TOOL]));
      assert.equal(first.doneItems.length, 2);
      assert.deepEqual(
        first.doneItems.map((i) => (i as { call_id: string }).call_id),
        ["tool_a", "tool_b"],
      );

      const second = await post({
        ...userTurn("do two things", [EXEC_TOOL]),
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "do two things" }] },
          { type: "function_call", name: "exec_command", arguments: '{"command":"one"}', call_id: "tool_a" },
          { type: "function_call", name: "exec_command", arguments: '{"command":"two"}', call_id: "tool_b" },
          { type: "function_call_output", call_id: "tool_a", output: "A" },
          { type: "function_call_output", call_id: "tool_b", output: "B" },
        ],
      });
      assert.equal(second.text, "A+B");
    },
  );
});

test("freeform tool calls are emitted as custom_tool_call with a raw input", async () => {
  await withBridge(
    [
      async ({ callTool }) => {
        await callTool("apply_patch", { input: "*** Begin Patch" }, "tool_p");
        return "patched";
      },
    ],
    async (post) => {
      const frames = await post(
        userTurn("patch it", [
          {
            type: "custom",
            name: "apply_patch",
            description: "apply a patch",
            format: { type: "grammar", syntax: "lark", definition: "start: ..." },
          },
        ]),
      );
      assert.deepEqual(frames.doneItems, [
        {
          type: "custom_tool_call",
          name: "apply_patch",
          input: "*** Begin Patch",
          call_id: "tool_p",
        },
      ]);
    },
  );
});

test("a bearer token is required when one is configured", async () => {
  const handle = stubAgent([async () => "ok"]);
  const guarded: BridgeConfig = { ...config, bridgeKey: "s3cret" };
  const manager = new SessionManager(guarded, handle.factory);
  const server = createBridgeServer(guarded, manager);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const missing = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(missing.status, 401);

    const wrong = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
      body: "{}",
    });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer s3cret" },
      body: JSON.stringify(userTurn("hi")),
    });
    assert.equal(ok.status, 200);
    await ok.text();
  } finally {
    await manager.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a run failure becomes response.failed, never a bare closed stream", async () => {
  await withBridge(
    [
      async () => {
        throw new Error("model exploded");
      },
    ],
    async (post) => {
      const frames = await post(userTurn("break"));
      // "stream closed before response.completed" would hide the real cause.
      assert.ok(frames.failed, "expected a response.failed frame");
      const response = frames.failed?.response as {
        error?: { code?: string; message?: string };
        id?: string;
      };
      assert.equal(typeof response.id, "string");
      assert.ok(String(response.error?.message).includes("model exploded"));
    },
  );
});
