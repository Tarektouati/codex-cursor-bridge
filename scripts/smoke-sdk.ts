/**
 * Step-1 skeleton probe: prove the Cursor SDK can act as a backend for a
 * caller-owned tool loop before any HTTP translation exists.
 *
 * Four things have to hold for the bridge design to work at all:
 *   1. `systemPrompt` is permitted on this account (it is gated per account).
 *   2. `tools: ["mcp"]` removes the built-in toolset but keeps custom tools.
 *   3. Assistant text arrives as incremental deltas, not one final blob.
 *   4. A custom tool's `execute()` can block, and the same run resumes when it
 *      finally resolves. This is what lets a tool call cross an HTTP boundary.
 *
 * Run: CURSOR_API_KEY=... npm run smoke
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  Agent,
  Cursor,
  type InteractionUpdate,
  type ModelSelection,
  type SDKCustomToolResult,
  type SDKMessage,
} from "@cursor/sdk";

const DEFER_MS = 5_000;

function requireApiKey(): string {
  const key = process.env.CURSOR_API_KEY?.trim();
  if (!key) {
    throw new Error("CURSOR_API_KEY must be set");
  }
  return key;
}

async function pickModel(apiKey: string): Promise<ModelSelection> {
  const models = await Cursor.models.list({ apiKey });
  const wanted = process.env.BRIDGE_MODEL?.trim();
  const chosen = wanted
    ? models.find((m) => m.id === wanted)
    : (models.find((m) => m.id === "composer-2.5") ?? models[0]);
  if (!chosen) {
    throw new Error(
      wanted ? `model ${wanted} not available` : "no models available",
    );
  }
  console.log(
    `[models] ${models.length} available, using "${chosen.id}"` +
      ` (${models.length > 12 ? `e.g. ${models.slice(0, 12).map((m) => m.id).join(", ")}, ...` : models.map((m) => m.id).join(", ")})`,
  );
  const defaultVariant = chosen.variants?.find((v) => v.isDefault);
  return defaultVariant
    ? { id: chosen.id, params: defaultVariant.params }
    : { id: chosen.id };
}

async function main(): Promise<void> {
  const apiKey = requireApiKey();
  const model = await pickModel(apiKey);

  // A disposable cwd: the agent has no file tools, but cwd still scopes the
  // local agent store and workspace context. Using a temp dir also lets us
  // assert the agent left the filesystem alone.
  const workspace = await mkdtemp(join(tmpdir(), "codex-cursor-bridge-smoke-"));

  let toolEntered: ((v: void) => void) | undefined;
  const toolEnteredPromise = new Promise<void>((r) => {
    toolEntered = r;
  });
  const seenCallIds: string[] = [];

  const results = {
    systemPromptAccepted: false,
    sawTextDelta: false,
    deltaCount: 0,
    toolInvoked: false,
    resumedAfterDefer: false,
    advertisedTools: undefined as string[] | undefined,
  };

  // `systemPrompt` is gated per account; without access the first send() fails
  // with "unknown option '--system-prompt'". Probe it explicitly so the bridge
  // knows which path it is on.
  const trySystemPrompt = process.env.BRIDGE_TRY_SYSTEM_PROMPT === "1";

  await using agent = await Agent.create({
    apiKey,
    model,
    ...(trySystemPrompt
      ? {
          systemPrompt:
            "You are a test harness backend. Follow instructions literally " +
            "and use the provided tools when asked. Be terse.",
        }
      : {}),
    // "mcp" is the capability group that carries local.customTools. Naming it
    // alone drops every built-in tool (shell/read/edit/...) while keeping ours.
    tools: ["mcp"],
    disallowedTools: ["task"],
    local: {
      cwd: workspace,
      settingSources: [],
      enableAgentRetries: false,
      customTools: {
        bridge_probe: {
          description:
            "Records a note. Call this exactly once when the user asks you to.",
          inputSchema: {
            type: "object",
            properties: { note: { type: "string" } },
            required: ["note"],
          },
          async execute(args, context): Promise<SDKCustomToolResult> {
            results.toolInvoked = true;
            if (context.toolCallId) {
              seenCallIds.push(context.toolCallId);
            }
            console.log(
              `[tool] entered bridge_probe callId=${context.toolCallId ?? "<none>"} args=${JSON.stringify(args)}`,
            );
            toolEntered?.();
            // The whole design hinges on this: hold the promise open the way an
            // HTTP round trip to Codex would, then resolve and see if the run
            // picks up where it left off.
            console.log(`[tool] deferring result for ${DEFER_MS}ms...`);
            await delay(DEFER_MS);
            console.log("[tool] resolving deferred result");
            return "note recorded: ok";
          },
        },
      },
    },
  });

  console.log(
    `[agent] created id=${agent.agentId} systemPrompt=${trySystemPrompt ? "requested" : "omitted"}`,
  );

  const onDelta = ({ update }: { update: InteractionUpdate }): void => {
    if (update.type === "text-delta") {
      results.deltaCount += 1;
      if (!results.sawTextDelta) {
        results.sawTextDelta = true;
        console.log("[stream] first text-delta received");
      }
    }
  };

  // --- Turn 1: plain text, no tools -----------------------------------------
  console.log("\n=== turn 1: text only ===");
  const run1 = await agent.send(
    'Reply with exactly the string SMOKE_TEXT_OK and nothing else.',
    { onDelta },
  );
  console.log(`[run] id=${run1.id}`);
  for await (const event of run1.stream()) {
    noteSystemEvent(event, results);
  }
  const result1 = await run1.wait();
  console.log(
    `[run] status=${result1.status} deltas=${results.deltaCount} result=${JSON.stringify(result1.result)}`,
  );
  if (result1.error) {
    console.log(`[run] error=${JSON.stringify(result1.error)}`);
  }
  results.systemPromptAccepted =
    !trySystemPrompt ||
    !(result1.error?.message ?? "").includes("--system-prompt");

  // --- Turn 2: force the custom tool, with a deferred result ----------------
  console.log("\n=== turn 2: deferred custom tool ===");
  const run2 = await agent.send(
    'Call the bridge_probe tool with note="hello", then reply with exactly SMOKE_TOOL_OK.',
    { onDelta },
  );
  console.log(`[run] id=${run2.id}`);
  for await (const event of run2.stream()) {
    noteSystemEvent(event, results);
    if (event.type === "tool_call") {
      console.log(
        `[stream] tool_call name=${event.name} status=${event.status} call_id=${event.call_id}`,
      );
    }
  }
  const result2 = await run2.wait();
  results.resumedAfterDefer =
    result2.status === "finished" && results.toolInvoked;
  console.log(
    `[run] status=${result2.status} result=${JSON.stringify(result2.result)}`,
  );
  if (result2.error) {
    console.log(`[run] error=${JSON.stringify(result2.error)}`);
  }

  await Promise.race([toolEnteredPromise, delay(1)]);

  // --- Did the agent touch the filesystem despite having no file tools? -----
  const leftovers = await readdir(workspace, { recursive: true });
  await rm(workspace, { recursive: true, force: true });

  console.log("\n=== verdict ===");
  report("systemPrompt accepted", results.systemPromptAccepted);
  report(
    "built-in tools suppressed (workspace untouched)",
    leftovers.length === 0,
    leftovers.length === 0 ? "" : `stray entries: ${leftovers.join(", ")}`,
  );
  report(
    "incremental text deltas",
    results.sawTextDelta,
    `${results.deltaCount} deltas`,
  );
  report("custom tool invoked", results.toolInvoked);
  report(
    `run resumed after ${DEFER_MS}ms deferral`,
    results.resumedAfterDefer,
    `final status=${result2.status}`,
  );
  report(
    "custom tool call ids present",
    seenCallIds.length > 0 && seenCallIds.every((id) => id.length > 0),
    seenCallIds.join(", "),
  );
  if (results.advertisedTools) {
    console.log(
      `  info: system event advertised tools: ${results.advertisedTools.join(", ") || "(none)"}`,
    );
  } else {
    console.log("  info: no system init event carried a tools list");
  }

  const ok =
    results.systemPromptAccepted &&
    results.sawTextDelta &&
    results.toolInvoked &&
    results.resumedAfterDefer;
  if (!ok) {
    process.exitCode = 2;
  }
}

function noteSystemEvent(
  event: SDKMessage,
  results: { advertisedTools?: string[] | undefined },
): void {
  if (event.type === "system" && event.tools) {
    results.advertisedTools = event.tools;
  }
}

function report(label: string, pass: boolean, detail = ""): void {
  console.log(`  ${pass ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

await main();
