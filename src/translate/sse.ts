import type { ServerResponse } from "node:http";

import { log } from "../log.js";
import type { ResponseItem, ResponseUsage } from "./responses-types.js";

/**
 * Emits Responses API SSE frames to one Codex HTTP turn.
 *
 * Codex 0.140 ignores the `event:` line entirely and dispatches on the JSON
 * `type` field, so only `data:` is written. Frames whose required fields are
 * missing are silently dropped by Codex, which is why every emitter here takes
 * those fields explicitly rather than defaulting them.
 */
export class SseWriter {
  private readonly res: ServerResponse;
  readonly responseId: string;
  private outputIndex = 0;
  private closed = false;
  /** Set once a terminal frame (completed/failed) has been written. */
  private terminal = false;

  constructor(res: ServerResponse, responseId: string) {
    this.res = res;
    this.responseId = responseId;
  }

  get isClosed(): boolean {
    return this.closed || this.res.writableEnded;
  }

  get isTerminal(): boolean {
    return this.terminal;
  }

  /** Claims the next `output_index`, which Codex uses to order items. */
  nextIndex(): number {
    return this.outputIndex++;
  }

  writeHead(): void {
    this.res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.res.flushHeaders?.();
  }

  private frame(payload: Record<string, unknown>): void {
    if (this.isClosed) {
      return;
    }
    this.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  created(): void {
    this.frame({
      type: "response.created",
      response: { id: this.responseId, object: "response", status: "in_progress" },
    });
  }

  outputItemAdded(index: number, item: ResponseItem): void {
    this.frame({
      type: "response.output_item.added",
      output_index: index,
      item,
    });
  }

  outputItemDone(index: number, item: ResponseItem): void {
    this.frame({
      type: "response.output_item.done",
      output_index: index,
      item,
    });
  }

  outputTextDelta(itemId: string, index: number, delta: string): void {
    this.frame({
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: index,
      content_index: 0,
      delta,
    });
  }

  /**
   * A reasoning item must be opened as an output item before any summary part
   * or delta references it, or Codex logs "ReasoningSummaryPartAdded without
   * active item" and discards the reasoning.
   */
  reasoningItemAdded(itemId: string, index: number): void {
    this.outputItemAdded(index, {
      type: "reasoning",
      id: itemId,
      summary: [],
    } as unknown as ResponseItem);
  }

  reasoningItemDone(itemId: string, index: number, text: string): void {
    this.outputItemDone(index, {
      type: "reasoning",
      id: itemId,
      summary: text ? [{ type: "summary_text", text }] : [],
    } as unknown as ResponseItem);
  }

  reasoningSummaryPartAdded(itemId: string, index: number): void {
    this.frame({
      type: "response.reasoning_summary_part.added",
      item_id: itemId,
      output_index: index,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
  }

  reasoningSummaryDelta(itemId: string, index: number, delta: string): void {
    this.frame({
      type: "response.reasoning_summary_text.delta",
      item_id: itemId,
      output_index: index,
      summary_index: 0,
      delta,
    });
  }

  /** Terminal. `response.id` is required by Codex; usage is all-or-nothing. */
  completed(usage?: ResponseUsage): void {
    if (this.terminal) {
      return;
    }
    this.terminal = true;
    const response: Record<string, unknown> = {
      id: this.responseId,
      object: "response",
      status: "completed",
    };
    if (usage) {
      response.usage = usage;
    }
    this.frame({ type: "response.completed", response });
    this.end();
  }

  /**
   * Terminal. Codex classifies by `error.code`: anything outside its fatal set
   * is retried, and `rate_limit_exceeded` additionally honours a delay scraped
   * from the message text.
   */
  failed(code: string, message: string): void {
    if (this.terminal) {
      return;
    }
    this.terminal = true;
    this.frame({
      type: "response.failed",
      response: {
        id: this.responseId,
        object: "response",
        status: "failed",
        error: { code, message },
      },
    });
    this.end();
  }

  end(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.res.end();
    } catch (err) {
      log.debug("sse end failed", { err: String(err) });
    }
  }
}
