import { randomUUID } from "node:crypto";

import {
  Agent,
  CursorAgentError,
  RateLimitError,
  type InteractionUpdate,
  type Run,
  type RunResult,
  type SDKAgent,
  type SDKCustomTool,
} from "@cursor/sdk";

import type { BridgeConfig } from "./config.js";
import { log } from "./log.js";
import type { TurnContext, TurnHandler } from "./server.js";
import {
  buildFirstPrompt,
  buildReplayPrompt,
  extractCwd,
  extractNewUserText,
  extractToolOutputs,
} from "./translate/input.js";
import type { ResponsesRequest } from "./translate/responses-types.js";
import type { SseWriter } from "./translate/sse.js";
import {
  buildCustomTools,
  freeformPayload,
  type ToolCallRequest,
} from "./translate/tools.js";

/**
 * Creating the Cursor agent is injectable so tests can drive the whole HTTP and
 * tool-round-trip path against a stub instead of a live model.
 */
export interface AgentFactoryOptions {
  apiKey: string;
  model: string;
  cwd: string;
  systemPrompt: string | undefined;
  customTools: Record<string, SDKCustomTool>;
}

export type AgentFactory = (options: AgentFactoryOptions) => Promise<SDKAgent>;

export const createCursorAgent: AgentFactory = (options) =>
  Agent.create({
    apiKey: options.apiKey,
    model: { id: options.model },
    // "mcp" is the capability group carrying local.customTools. Listing it
    // alone drops every built-in tool while keeping the bridged ones, so Codex
    // retains ownership of the tool loop.
    tools: ["mcp"],
    disallowedTools: ["task"],
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    local: {
      cwd: options.cwd,
      settingSources: [],
      customTools: options.customTools,
      enableAgentRetries: true,
    },
  });

/** How a single Codex HTTP turn ended. */
type TurnEnd =
  | { kind: "tools"; calls: ToolCallRequest[] }
  | { kind: "finished"; text?: string | undefined }
  | { kind: "error"; code: string; message: string };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (v) => {
      if (!d.settled) {
        d.settled = true;
        resolve(v);
      }
    },
    reject: (e) => {
      if (!d.settled) {
        d.settled = true;
        reject(e);
      }
    },
  };
  return d;
}

interface ActiveTurn {
  itemId: string;
  textIndex: number | undefined;
  text: string;
  reasoningItemId: string;
  reasoningIndex: number | undefined;
  reasoningText: string;
  reasoningClosed: boolean;
}

/** Reason Codex should retry, mapped from a Cursor SDK failure. */
function classifyError(err: unknown): { code: string; message: string } {
  if (err instanceof RateLimitError) {
    // Codex does not retry HTTP 429, but it does retry a `response.failed`
    // with this code, and scrapes the delay out of the message text.
    const seconds = extractRetrySeconds(err) ?? 20;
    return {
      code: "rate_limit_exceeded",
      message: `Cursor rate limit reached. Please try again in ${seconds}s.`,
    };
  }
  if (err instanceof CursorAgentError) {
    return {
      code: err.isRetryable ? "server_is_overloaded" : "bridge_error",
      message: err.message,
    };
  }
  return { code: "bridge_error", message: String(err) };
}

function extractRetrySeconds(err: unknown): number | undefined {
  const raw = (err as { retryAfter?: unknown }).retryAfter;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.ceil(raw);
  }
  const message = err instanceof Error ? err.message : "";
  const match = /(\d+(?:\.\d+)?)\s*(?:s|seconds?)/i.exec(message);
  return match?.[1] ? Math.ceil(Number(match[1])) : undefined;
}

/**
 * One Codex conversation, backed by one long-lived Cursor agent.
 *
 * The interesting property is that a Cursor run stays alive across Codex HTTP
 * turns: when the model calls a bridged tool, `execute()` parks on a promise,
 * this class closes the HTTP turn with a `function_call` item, and the promise
 * is resolved from the tool output on Codex's next request.
 */
class Session {
  readonly key: string;
  lastUsedAt = Date.now();

  private readonly config: BridgeConfig;
  private agent: SDKAgent | undefined;
  private model: string;
  private cwd: string;
  private useSystemPrompt: boolean;

  private readonly pending = new Map<string, Deferred<string>>();
  private batch: ToolCallRequest[] = [];
  private batchTimer: NodeJS.Timeout | undefined;
  /** Tool calls that arrived with no HTTP turn to carry them; emitted next turn. */
  private carryOver: ToolCallRequest[] = [];

  private gate: Deferred<TurnEnd> | undefined;
  private writer: SseWriter | undefined;
  private turn: ActiveTurn | undefined;
  /** A terminal run state reached while no HTTP turn was open. */
  private settled: TurnEnd | undefined;

  private run: Run | undefined;
  private started = false;
  private customTools: Record<string, SDKCustomTool> = {};
  private toolNames: string[] = [];
  private lock: Promise<unknown> = Promise.resolve();

  private readonly createAgent: AgentFactory;

  constructor(key: string, config: BridgeConfig, createAgent: AgentFactory) {
    this.key = key;
    this.config = config;
    this.createAgent = createAgent;
    this.model = config.defaultModel;
    this.cwd = config.defaultCwd;
    this.useSystemPrompt = process.env.BRIDGE_SYSTEM_PROMPT === "1";
  }

  /** Serializes turns; Codex issues one request at a time per conversation. */
  async handle(ctx: TurnContext): Promise<void> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => {
      release = r;
    });
    await previous.catch(() => undefined);
    try {
      await this.runTurn(ctx);
    } finally {
      release();
    }
  }

  private async runTurn({ body, writer }: TurnContext): Promise<void> {
    this.lastUsedAt = Date.now();
    this.writer = writer;
    this.turn = {
      itemId: `msg_${randomUUID()}`,
      textIndex: undefined,
      text: "",
      reasoningItemId: `rs_${randomUUID()}`,
      reasoningIndex: undefined,
      reasoningText: "",
      reasoningClosed: false,
    };

    const gate = deferred<TurnEnd>();
    this.gate = gate;

    let end: TurnEnd;
    try {
      end = await this.advance(body, gate);
    } catch (err) {
      const { code, message } = classifyError(err);
      log.error("turn error", { session: this.key, code, message });
      end = { kind: "error", code, message };
    }

    this.writeClosing(end);
    this.gate = undefined;
    this.writer = undefined;
    this.turn = undefined;
  }

  /** Decides what this request means and drives the Cursor run accordingly. */
  private async advance(
    body: ResponsesRequest,
    gate: Deferred<TurnEnd>,
  ): Promise<TurnEnd> {
    if (this.carryOver.length > 0) {
      const calls = this.carryOver;
      this.carryOver = [];
      return { kind: "tools", calls };
    }
    if (this.settled) {
      const settled = this.settled;
      this.settled = undefined;
      return settled;
    }

    const outputs = extractToolOutputs(body.input);
    const matched = outputs.filter((o) => this.pending.has(o.callId));

    if (matched.length > 0) {
      log.debug("delivering tool outputs", {
        session: this.key,
        count: matched.length,
      });
      for (const out of matched) {
        const waiter = this.pending.get(out.callId);
        this.pending.delete(out.callId);
        waiter?.resolve(out.output);
      }
      return gate.promise;
    }

    // No pending call matched. Either this is a new user turn, or the bridge
    // lost the run (restart, idle sweep) while Codex kept going.
    const userText = extractNewUserText(body.input);
    const desynced = outputs.length > 0 && !userText.trim();

    if (desynced) {
      log.warn("tool outputs with no live run; replaying transcript", {
        session: this.key,
      });
      await this.reset();
    }

    const prompt = desynced
      ? buildReplayPrompt(body.input)
      : this.started
        ? userText
        : buildFirstPrompt(body.instructions, userText, []);

    if (!prompt.trim()) {
      return {
        kind: "finished",
        text: "",
      };
    }

    await this.send(body, prompt);
    return gate.promise;
  }

  private async send(body: ResponsesRequest, prompt: string): Promise<void> {
    const built = buildCustomTools(body.tools, (req) => this.onToolCall(req));
    this.customTools = built.customTools;
    this.toolNames = [...built.kinds.keys()];

    const requestedModel = body.model?.trim();
    if (requestedModel) {
      this.model = requestedModel;
    }
    const detectedCwd = extractCwd(body.input);
    if (detectedCwd) {
      this.cwd = detectedCwd;
    }

    // The preamble names the bridged tools, which are only known once the
    // request's tool list has been parsed.
    const finalPrompt = this.started
      ? prompt
      : buildFirstPrompt(body.instructions, extractNewUserText(body.input), this.toolNames) ||
        prompt;

    await this.ensureAgent();
    const agent = this.agent;
    if (!agent) {
      throw new Error("agent unavailable");
    }

    try {
      await this.startRun(agent, finalPrompt);
    } catch (err) {
      // `systemPrompt` is enabled per account; without access the first send
      // fails with "unknown option '--system-prompt'". Fall back to carrying
      // the harness instructions in the prompt instead.
      if (this.useSystemPrompt && isSystemPromptRejection(err)) {
        log.warn("systemPrompt not permitted on this account; using prompt fallback", {
          session: this.key,
        });
        this.useSystemPrompt = false;
        await this.reset();
        await this.ensureAgent();
        const retryAgent = this.agent;
        if (!retryAgent) {
          throw new Error("agent unavailable after systemPrompt fallback");
        }
        await this.startRun(retryAgent, finalPrompt);
        return;
      }
      throw err;
    }
  }

  private async startRun(agent: SDKAgent, prompt: string): Promise<void> {
    const run = await agent.send(prompt, {
      onDelta: ({ update }) => this.onDelta(update),
      local: { customTools: this.customTools, force: true },
    });
    this.run = run;
    this.started = true;
    log.info("run started", {
      session: this.key,
      run: run.id,
      model: this.model,
      tools: this.toolNames.length,
    });

    // Drain the normalized stream in the background: the bridge reads text via
    // onDelta and tool calls via execute(), but draining keeps parity with the
    // documented usage and surfaces tool activity in the logs.
    void (async () => {
      try {
        for await (const event of run.stream()) {
          if (event.type === "tool_call") {
            log.debug("sdk tool_call", {
              session: this.key,
              status: event.status,
              callId: event.call_id,
            });
          }
        }
      } catch (err) {
        log.debug("stream drain ended", { err: String(err) });
      }
    })();

    void run
      .wait()
      .then((result) => this.onRunSettled(result))
      .catch((err: unknown) => {
        const { code, message } = classifyError(err);
        this.resolveGate({ kind: "error", code, message });
      });
  }

  private async ensureAgent(): Promise<void> {
    if (this.agent) {
      return;
    }
    log.info("creating cursor agent", {
      session: this.key,
      model: this.model,
      cwd: this.cwd,
      systemPrompt: this.useSystemPrompt,
    });
    this.agent = await this.createAgent({
      apiKey: this.config.cursorApiKey,
      model: this.model,
      cwd: this.cwd,
      systemPrompt: this.useSystemPrompt ? BRIDGE_SYSTEM_PROMPT : undefined,
      customTools: this.customTools,
    });
  }

  // --- tool round-trip ------------------------------------------------------

  /**
   * Parks the Cursor model's tool call until Codex returns a result. The
   * promise deliberately outlives the HTTP turn that reports the call.
   */
  private onToolCall(req: ToolCallRequest): Promise<string> {
    const waiter = deferred<string>();
    this.pending.set(req.callId, waiter);
    this.batch.push(req);
    log.info("tool call requested", {
      session: this.key,
      tool: req.name,
      callId: req.callId,
    });
    this.scheduleFlush();
    return waiter.promise;
  }

  /**
   * The model can issue several tool calls in one step, and each arrives as a
   * separate `execute()`. Completing the turn on the first would orphan the
   * rest, so calls are collected for a short window and emitted together.
   */
  private scheduleFlush(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      this.flushBatch();
    }, this.config.toolBatchWindowMs);
    this.batchTimer.unref?.();
  }

  private flushBatch(): void {
    if (this.batch.length === 0) {
      return;
    }
    const calls = this.batch;
    this.batch = [];
    if (!this.resolveGate({ kind: "tools", calls })) {
      // No turn was open to carry them; hand them to the next request.
      log.warn("tool batch arrived with no open turn", {
        session: this.key,
        count: calls.length,
      });
      this.carryOver.push(...calls);
    }
  }

  private resolveGate(end: TurnEnd): boolean {
    const gate = this.gate;
    if (!gate || gate.settled) {
      return false;
    }
    gate.resolve(end);
    return true;
  }

  private onRunSettled(result: RunResult): void {
    log.info("run settled", {
      session: this.key,
      run: result.id,
      status: result.status,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
    });

    // Any tool still parked will never be answered now.
    for (const [callId, waiter] of this.pending) {
      waiter.reject(new Error(`run ${result.status} before tool ${callId} returned`));
    }
    this.pending.clear();

    const end: TurnEnd =
      result.status === "error"
        ? {
            kind: "error",
            ...classifyError(new Error(result.error?.message ?? "run failed")),
          }
        : { kind: "finished", text: result.result };

    if (!this.resolveGate(end)) {
      this.settled = end;
    }
  }

  // --- streaming ------------------------------------------------------------

  private onDelta(update: InteractionUpdate): void {
    if (update.type === "text-delta") {
      this.appendText(update.text);
      return;
    }
    if (update.type === "thinking-delta" && this.config.streamThinking) {
      this.appendThinking(update.text);
    }
  }

  private appendText(text: string): void {
    const turn = this.turn;
    const writer = this.writer;
    if (!turn || !writer || writer.isTerminal || !text) {
      return;
    }
    // Reasoning precedes the answer, so close its item before the message opens
    // to keep output items properly nested for Codex.
    this.closeReasoning();
    if (turn.textIndex === undefined) {
      turn.textIndex = writer.nextIndex();
      writer.outputItemAdded(turn.textIndex, {
        type: "message",
        role: "assistant",
        content: [],
      });
    }
    turn.text += text;
    writer.outputTextDelta(turn.itemId, turn.textIndex, text);
  }

  private appendThinking(text: string): void {
    const turn = this.turn;
    const writer = this.writer;
    if (!turn || !writer || writer.isTerminal || !text || turn.reasoningClosed) {
      return;
    }
    if (turn.reasoningIndex === undefined) {
      turn.reasoningIndex = writer.nextIndex();
      writer.reasoningItemAdded(turn.reasoningItemId, turn.reasoningIndex);
      writer.reasoningSummaryPartAdded(turn.reasoningItemId, turn.reasoningIndex);
    }
    turn.reasoningText += text;
    writer.reasoningSummaryDelta(turn.reasoningItemId, turn.reasoningIndex, text);
  }

  private closeReasoning(): void {
    const turn = this.turn;
    const writer = this.writer;
    if (!turn || !writer || turn.reasoningClosed || turn.reasoningIndex === undefined) {
      return;
    }
    turn.reasoningClosed = true;
    writer.reasoningItemDone(
      turn.reasoningItemId,
      turn.reasoningIndex,
      turn.reasoningText,
    );
  }

  private writeClosing(end: TurnEnd): void {
    const writer = this.writer;
    const turn = this.turn;
    if (!writer || !turn) {
      return;
    }

    if (end.kind === "error") {
      writer.failed(end.code, end.message);
      return;
    }

    // Any open reasoning item must be closed before sibling items are emitted.
    this.closeReasoning();

    // Deltas only drive the TUI; Codex takes the turn's actual content from
    // `output_item.done`, so the finished message must always be emitted.
    if (turn.textIndex !== undefined) {
      writer.outputItemDone(turn.textIndex, {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: turn.text }],
      });
    }

    if (end.kind === "tools") {
      for (const call of end.calls) {
        const index = writer.nextIndex();
        const item =
          call.kind === "freeform"
            ? {
                type: "custom_tool_call" as const,
                name: call.name,
                input: freeformPayload(call.args),
                call_id: call.callId,
              }
            : {
                type: "function_call" as const,
                name: call.name,
                arguments: JSON.stringify(call.args ?? {}),
                call_id: call.callId,
              };
        writer.outputItemAdded(index, item);
        writer.outputItemDone(index, item);
      }
      writer.completed();
      return;
    }

    // A completed turn with no items at all makes Codex show an empty reply, so
    // fall back to the run's final text when no deltas were seen this turn.
    if (turn.textIndex === undefined) {
      const text = end.text?.trim() ?? "";
      const index = writer.nextIndex();
      writer.outputItemDone(index, {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: text || "(no output)" }],
      });
    }
    writer.completed();
  }

  // --- lifecycle ------------------------------------------------------------

  private async reset(): Promise<void> {
    for (const [, waiter] of this.pending) {
      waiter.reject(new Error("session reset"));
    }
    this.pending.clear();
    this.batch = [];
    this.carryOver = [];
    this.started = false;
    const agent = this.agent;
    this.agent = undefined;
    this.run = undefined;
    if (agent) {
      await agent[Symbol.asyncDispose]().catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    const run = this.run;
    try {
      if (
        run &&
        run.status === "running" &&
        run.supports("cancel") &&
        typeof run.cancel === "function"
      ) {
        await run.cancel();
      }
    } catch (err) {
      log.debug("run cancel during dispose failed", { err: String(err) });
    }
    await this.reset();
  }
}

const BRIDGE_SYSTEM_PROMPT =
  "You are the model behind an external coding harness. You have no built-in " +
  "tools; use only the tools the harness provides. Follow the harness " +
  "instructions that arrive in the conversation.";

function isSystemPromptRejection(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return message.includes("--system-prompt");
}

/** Routes Codex conversations to sessions and reaps idle ones. */
export class SessionManager implements TurnHandler {
  private readonly config: BridgeConfig;
  private readonly createAgent: AgentFactory;
  private readonly sessions = new Map<string, Session>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(config: BridgeConfig, createAgent: AgentFactory = createCursorAgent) {
    this.config = config;
    this.createAgent = createAgent;
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  async handle(ctx: TurnContext): Promise<void> {
    const key = sessionKey(ctx);
    let session = this.sessions.get(key);
    if (!session) {
      session = new Session(key, this.config, this.createAgent);
      this.sessions.set(key, session);
      log.info("new session", { session: key, total: this.sessions.size });
    }
    await session.handle(ctx);
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - this.config.sessionIdleMs;
    for (const [key, session] of [...this.sessions]) {
      if (session.lastUsedAt < cutoff) {
        this.sessions.delete(key);
        log.info("reaping idle session", { session: key });
        await session.dispose();
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweeper);
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.dispose()));
  }
}

/**
 * Codex is stateless per request, so the conversation identity has to come off
 * the wire. It sets `prompt_cache_key` to its thread id on every request; the
 * `thread-id` header is the fallback.
 */
export function sessionKey(ctx: TurnContext): string {
  const fromBody = ctx.body.prompt_cache_key?.trim();
  if (fromBody) {
    return fromBody;
  }
  const header = ctx.headers["thread-id"] ?? ctx.headers["session-id"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return fromHeader?.trim() || "default";
}
