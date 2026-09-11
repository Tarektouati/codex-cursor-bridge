const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) {
    return;
  }
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), msg];
  if (fields && Object.keys(fields).length > 0) {
    parts.push(
      Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" "),
    );
  }
  const line = parts.join(" ");
  if (level === "error" || level === "warn") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) =>
    emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) =>
    emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) =>
    emit("error", msg, fields),
};
