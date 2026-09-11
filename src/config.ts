/** Bridge configuration, resolved once at startup from the environment. */
export interface BridgeConfig {
  host: string;
  port: number;
  /** Cursor credential, passed straight through to the SDK. */
  cursorApiKey: string;
  /** Shared secret Codex must present as `Authorization: Bearer`. */
  bridgeKey: string | undefined;
  /** Fallback cwd for the Cursor agent when Codex's prompt doesn't reveal one. */
  defaultCwd: string;
  /** Model id used when a request omits one. */
  defaultModel: string;
  /** How long to collect sibling tool calls before flushing them as one batch. */
  toolBatchWindowMs: number;
  /** Idle sessions are disposed after this long. */
  sessionIdleMs: number;
  /** Forward Cursor's thinking deltas as Responses reasoning summary deltas. */
  streamThinking: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Reads configuration and enforces the exposure rule: the bridge hands a Cursor
 * API key to anyone who can reach it, so it may only listen off-loopback when a
 * shared secret is configured.
 */
export function loadConfig(env = process.env): BridgeConfig {
  const cursorApiKey = env.CURSOR_API_KEY?.trim();
  if (!cursorApiKey) {
    throw new Error(
      "CURSOR_API_KEY is not set. Mint a key at https://cursor.com/dashboard/integrations",
    );
  }

  const host = env.BRIDGE_HOST?.trim() || "127.0.0.1";
  const bridgeKey = env.CURSOR_BRIDGE_KEY?.trim() || undefined;

  if (!isLoopback(host) && !bridgeKey) {
    throw new Error(
      `refusing to bind ${host}: CURSOR_BRIDGE_KEY must be set to listen off-loopback`,
    );
  }

  const logLevel = (env.BRIDGE_LOG_LEVEL?.trim() ??
    "info") as BridgeConfig["logLevel"];
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new Error(`BRIDGE_LOG_LEVEL must be debug|info|warn|error`);
  }

  return {
    host,
    port: intFromEnv("BRIDGE_PORT", 4712),
    cursorApiKey,
    bridgeKey,
    defaultCwd: env.BRIDGE_CWD?.trim() || process.cwd(),
    defaultModel: env.BRIDGE_MODEL?.trim() || "composer-2.5",
    toolBatchWindowMs: intFromEnv("BRIDGE_TOOL_BATCH_MS", 50),
    sessionIdleMs: intFromEnv("BRIDGE_SESSION_IDLE_MS", 30 * 60_000),
    streamThinking: boolFromEnv("BRIDGE_STREAM_THINKING", true),
    logLevel,
  };
}
