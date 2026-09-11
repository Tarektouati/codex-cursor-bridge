/**
 * Drives a full two-request tool round trip against a running bridge, the way
 * Codex would: ask for a tool, get a `function_call` back, execute it locally,
 * then resend the whole transcript plus a `function_call_output` and check the
 * same Cursor run picks up and finishes.
 *
 * Run: node --import tsx scripts/probe-roundtrip.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ResponseItem } from "../src/translate/responses-types.js";

const BASE = process.env.BRIDGE_URL ?? "http://127.0.0.1:4712/v1";
const KEY = process.env.CURSOR_BRIDGE_KEY ?? "";
const MODEL = process.env.BRIDGE_MODEL ?? "composer-2.5";

interface StreamResult {
  frames: Array<Record<string, unknown>>;
  doneItems: ResponseItem[];
  text: string;
  status: "completed" | "failed" | "none";
  failure?: { code?: string; message?: string };
}

async function post(body: unknown): Promise<StreamResult> {
  const res = await fetch(`${BASE}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const out: StreamResult = {
    frames: [],
    doneItems: [],
    text: "",
    status: "none",
  };
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf("\n\n");
      const line = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!line) {
        continue;
      }
      const frame = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      out.frames.push(frame);
      const type = String(frame.type);
      if (type === "response.output_text.delta") {
        out.text += String(frame.delta ?? "");
      } else if (type === "response.output_item.done") {
        out.doneItems.push(frame.item as ResponseItem);
      } else if (type === "response.completed") {
        out.status = "completed";
      } else if (type === "response.failed") {
        out.status = "failed";
        const response = frame.response as { error?: { code?: string; message?: string } };
        out.failure = response?.error ?? {};
      }
    }
  }
  return out;
}

const EXEC_TOOL = {
  type: "function",
  name: "exec_command",
  description: "Run a shell command and return its combined output.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run" },
    },
    required: ["command"],
  },
};

async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "bridge-roundtrip-"));
  const cacheKey = `probe-${randomUUID()}`;
  const target = join(workspace, "ok.txt");

  const history: ResponseItem[] = [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            `Use the exec_command tool to create a file at ${target} containing ` +
            `exactly the word hello. After the tool reports success, reply with ` +
            `exactly ROUNDTRIP_OK.`,
        },
      ],
    },
  ];

  const request = (input: ResponseItem[]) => ({
    model: MODEL,
    instructions:
      "You are a coding agent. Use the provided tools to accomplish the task. " +
      "Never claim a file exists until a tool call confirms it.",
    input,
    tools: [EXEC_TOOL],
    tool_choice: "auto",
    parallel_tool_calls: false,
    stream: true,
    store: false,
    prompt_cache_key: cacheKey,
  });

  let turn = 0;
  let finalText = "";
  while (turn < 6) {
    turn += 1;
    const result = await post(request(history));
    console.log(
      `[turn ${turn}] status=${result.status} items=${result.doneItems.length} textLen=${result.text.length}`,
    );
    if (result.status === "failed") {
      throw new Error(
        `turn ${turn} failed: ${result.failure?.code} ${result.failure?.message}`,
      );
    }

    const calls = result.doneItems.filter((i) => i.type === "function_call");
    for (const item of result.doneItems) {
      history.push(item);
    }
    if (calls.length === 0) {
      finalText = result.text;
      break;
    }

    // Act as Codex's sandbox: actually run the command, then hand back output.
    for (const call of calls) {
      const { name, arguments: argsJson, call_id: callId } = call as {
        name: string;
        arguments: string;
        call_id: string;
      };
      const args = JSON.parse(argsJson) as { command?: string };
      console.log(`[turn ${turn}] executing ${name}: ${args.command}`);
      let output: string;
      try {
        output = execFileSync("/bin/sh", ["-c", args.command ?? ""], {
          encoding: "utf8",
          cwd: workspace,
          timeout: 15_000,
        });
        output = output.trim() || "(no output; exit code 0)";
      } catch (err) {
        output = `command failed: ${String(err)}`;
      }
      history.push({
        type: "function_call_output",
        call_id: callId,
        output,
      });
    }
  }

  const contents = await readFile(target, "utf8").catch(() => "");
  await rm(workspace, { recursive: true, force: true });

  console.log("\n=== verdict ===");
  console.log(`  turns: ${turn}`);
  console.log(`  final text: ${JSON.stringify(finalText.slice(0, 120))}`);
  console.log(`  file contents: ${JSON.stringify(contents)}`);

  assert.ok(turn >= 2, "expected at least one tool round trip");
  assert.match(contents, /hello/, "tool did not create the file");
  assert.match(finalText, /ROUNDTRIP_OK/, "model did not confirm completion");
  console.log("\n  PASS full tool round trip");
}

await main();
