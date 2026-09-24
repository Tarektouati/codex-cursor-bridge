#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { reportCatalog, writeCatalog } from "./catalog.js";
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

async function serve(): Promise<void> {
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

const HELP = `Usage: codex-cursor-bridge [command] [options]

Commands:
  serve              Start the bridge (default)
  catalog            Write the Codex model catalog for your Cursor account

Options:
  --out <path>       catalog: output file (default: $CODEX_HOME or ~/.codex,
                     then cursor-bridge-models.json)
  -h, --help         Show this help
  -v, --version      Show the version

Environment:
  CURSOR_API_KEY     Required. https://cursor.com/dashboard/integrations
  CURSOR_BRIDGE_KEY  Shared secret Codex presents as a bearer token
  BRIDGE_HOST, BRIDGE_PORT, BRIDGE_MODEL, BRIDGE_CWD, BRIDGE_LOG_LEVEL, ...

A .env file in the current directory is loaded if present; variables already
set in the environment take precedence.`;

function defaultCatalogPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(codexHome, "cursor-bridge-models.json");
}

async function catalog(out: string | undefined): Promise<void> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "CURSOR_API_KEY is not set. Mint a key at https://cursor.com/dashboard/integrations",
    );
  }
  const path = resolve(out ?? defaultCatalogPath());
  reportCatalog(path, await writeCatalog(apiKey, path));
  console.log(`\nAdd this to your Codex profile:\n  model_catalog_json = ${JSON.stringify(path)}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
    console.log(pkg.version);
    return;
  }

  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }

  const [command = "serve", ...rest] = positionals;
  if (rest.length > 0) {
    throw new Error(`unexpected argument "${rest[0]}"`);
  }
  switch (command) {
    case "serve":
      return serve();
    case "catalog":
      return catalog(values.out);
    default:
      throw new Error(`unknown command "${command}"`);
  }
}

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`codex-cursor-bridge: ${message}`);
  console.error("Run `codex-cursor-bridge --help` for usage.");
  process.exit(1);
}
