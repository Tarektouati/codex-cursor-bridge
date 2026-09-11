import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFirstPrompt,
  buildReplayPrompt,
  extractCwd,
  extractNewUserText,
  extractToolOutputs,
} from "../../src/translate/input.js";
import type { ResponseItem } from "../../src/translate/responses-types.js";

const userMsg = (text: string): ResponseItem => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

const assistantMsg = (text: string): ResponseItem => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

test("extractToolOutputs reads both function and custom tool outputs", () => {
  const outputs = extractToolOutputs([
    userMsg("hi"),
    { type: "function_call_output", call_id: "call_a", output: "stdout-a" },
    { type: "custom_tool_call_output", call_id: "call_b", output: "stdout-b" },
  ]);
  assert.deepEqual(outputs, [
    { callId: "call_a", output: "stdout-a" },
    { callId: "call_b", output: "stdout-b" },
  ]);
});

test("extractToolOutputs flattens array-shaped output", () => {
  const outputs = extractToolOutputs([
    {
      type: "function_call_output",
      call_id: "call_a",
      output: [
        { type: "output_text", text: "line one" },
        { type: "output_text", text: "line two" },
      ],
    },
  ]);
  assert.equal(outputs[0]?.output, "line one\nline two");
});

test("extractNewUserText returns every user turn on the first request", () => {
  // Codex opens with a developer permissions block plus AGENTS.md before the
  // actual prompt, and none of it has been seen by the Cursor agent yet.
  const text = extractNewUserText([
    { type: "message", role: "developer", content: [{ type: "input_text", text: "perms" }] },
    userMsg("agents.md"),
    userMsg("do the thing"),
  ]);
  assert.equal(text, "perms\n\nagents.md\n\ndo the thing");
});

test("extractNewUserText returns only text after the last assistant turn", () => {
  const text = extractNewUserText([
    userMsg("first"),
    assistantMsg("answered"),
    userMsg("follow up"),
  ]);
  assert.equal(text, "follow up");
});

test("extractNewUserText is empty when the request ends in a tool result", () => {
  // This is what makes a request classifiable as a tool continuation rather
  // than a new user turn.
  const text = extractNewUserText([
    userMsg("first"),
    { type: "function_call", name: "exec", arguments: "{}", call_id: "c1" },
    { type: "function_call_output", call_id: "c1", output: "done" },
  ]);
  assert.equal(text, "");
});

test("extractCwd pulls the working directory out of the environment block", () => {
  const cwd = extractCwd([
    userMsg("<environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>"),
  ]);
  assert.equal(cwd, "/tmp/project");
});

test("extractCwd returns undefined when absent", () => {
  assert.equal(extractCwd([userMsg("no context here")]), undefined);
});

test("buildFirstPrompt carries instructions and names the bridged tools", () => {
  const prompt = buildFirstPrompt("HARNESS RULES", "do the thing", [
    "exec_command",
    "update_plan",
  ]);
  assert.match(prompt, /exec_command, update_plan/);
  assert.match(prompt, /<harness_instructions>\nHARNESS RULES\n<\/harness_instructions>/);
  assert.match(prompt, /<user_request>\ndo the thing\n<\/user_request>/);
});

test("buildReplayPrompt renders calls and results for desync recovery", () => {
  const prompt = buildReplayPrompt([
    userMsg("make a file"),
    { type: "function_call", name: "exec_command", arguments: '{"command":"ls"}', call_id: "c1" },
    { type: "function_call_output", call_id: "c1", output: "ok.txt" },
  ]);
  assert.match(prompt, /\[user\] make a file/);
  assert.match(prompt, /\[tool call\] exec_command \{"command":"ls"\}/);
  assert.match(prompt, /\[tool result\] ok\.txt/);
});
