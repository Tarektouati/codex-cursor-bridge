import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BridgeConfig } from "./config.js";
import { log } from "./log.js";
import type { ResponsesRequest } from "./translate/responses-types.js";
import { SseWriter } from "./translate/sse.js";

/** Body-size ceiling: Codex resends full history, so this must be generous. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface TurnContext {
  body: ResponsesRequest;
  headers: IncomingMessage["headers"];
  writer: SseWriter;
}

export interface TurnHandler {
  handle(ctx: TurnContext): Promise<void>;
  shutdown(): Promise<void>;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function createBridgeServer(
  config: BridgeConfig,
  handler: TurnHandler,
): Server {
  return createServer((req, res) => {
    void route(req, res, config, handler).catch((err: unknown) => {
      log.error("unhandled request error", { err: String(err) });
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: String(err) } });
      } else {
        res.end();
      }
    });
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  config: BridgeConfig,
  handler: TurnHandler,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // Codex only ever calls POST /v1/responses, but it joins base_url literally,
  // so tolerate a base_url given with or without the /v1 segment.
  const isResponses = path === "/v1/responses" || path === "/responses";
  if (!isResponses) {
    sendJson(res, 404, { error: { message: `no route for ${req.method} ${path}` } });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: { message: "method not allowed" } });
    return;
  }

  if (config.bridgeKey) {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!presented || !constantTimeEquals(presented, config.bridgeKey)) {
      log.warn("rejected unauthenticated request");
      sendJson(res, 401, { error: { message: "invalid bearer token" } });
      return;
    }
  }

  let body: ResponsesRequest;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString("utf8") || "{}") as ResponsesRequest;
  } catch (err) {
    sendJson(res, 400, { error: { message: `invalid request body: ${String(err)}` } });
    return;
  }

  // Set BRIDGE_DUMP_DIR to capture raw requests; the tool list and item shapes
  // Codex sends vary by model metadata and feature flags, so seeing the real
  // payload beats guessing.
  const dumpDir = process.env.BRIDGE_DUMP_DIR?.trim();
  if (dumpDir) {
    const file = join(dumpDir, `req-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
    await writeFile(file, JSON.stringify(body, null, 2)).catch((err: unknown) =>
      log.warn("request dump failed", { err: String(err) }),
    );
    log.debug("dumped request", { file });
  }

  const input = Array.isArray(body.input) ? body.input : [];
  log.debug("responses request", {
    model: body.model ?? "",
    items: input.length,
    tools: body.tools?.length ?? 0,
    instructions: body.instructions?.length ?? 0,
    cacheKey: body.prompt_cache_key ?? "",
    itemTypes: input.map((i) => String(i.type)).join(","),
  });

  const writer = new SseWriter(res, `resp_${randomUUID()}`);
  writer.writeHead();
  writer.created();

  try {
    await handler.handle({ body, headers: req.headers, writer });
  } catch (err) {
    log.error("turn failed", { err: String(err), responseId: writer.responseId });
    // A stream that ends without a terminal frame makes Codex report
    // "stream closed before response.completed", which hides the real cause.
    writer.failed("bridge_error", String(err));
  } finally {
    if (!writer.isTerminal) {
      writer.failed("bridge_error", "turn ended without a terminal event");
    }
  }
}
