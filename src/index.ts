#!/usr/bin/env node
import { isLoopback, loadConfig } from "./config.js";
import { log, setLogLevel } from "./log.js";
import { createBridgeServer, type TurnHandler } from "./server.js";
import { SessionManager } from "./session.js";

/**
 * Minimal hardcoded handler used to verify the wire contract against a real
 * Codex CLI without involving the Cursor SDK. Enable with BRIDGE_FAKE=1.
 */
const fakeHandler: TurnHandler = {
  async handle({ writer }) {
    const index = writer.nextIndex();
    const itemId = `msg_${index}`;
    const text = "CURSOR_BACKEND_OK (fake handler)";
    writer.outputItemAdded(index, {
      type: "message",
      role: "assistant",
      content: [],
    });
    for (const chunk of text.match(/.{1,8}/g) ?? []) {
      writer.outputTextDelta(itemId, index, chunk);
    }
    writer.outputItemDone(index, {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
    writer.completed();
  },
  async shutdown() {},
};

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const useFake = process.env.BRIDGE_FAKE === "1";
  const handler: TurnHandler = useFake
    ? fakeHandler
    : new SessionManager(config);

  const server = createBridgeServer(config, handler);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });

  log.info("codex-cursor-bridge listening", {
    url: `http://${config.host}:${config.port}/v1`,
    model: config.defaultModel,
    cwd: config.defaultCwd,
    auth: config.bridgeKey ? "bearer required" : "none (loopback only)",
    handler: useFake ? "fake" : "cursor-sdk",
  });
  if (!isLoopback(config.host)) {
    log.warn("bridge is reachable off-loopback", { host: config.host });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info("shutting down", { signal });
    server.close();
    await handler.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

await main();
