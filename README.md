# codex-cursor-bridge

[![npm version](https://img.shields.io/npm/v/@tarektweeti/codex-cursor-bridge)](https://www.npmjs.com/package/@tarektweeti/codex-cursor-bridge)
[![npm downloads](https://img.shields.io/npm/dm/@tarektweeti/codex-cursor-bridge)](https://www.npmjs.com/package/@tarektweeti/codex-cursor-bridge)
[![CI](https://github.com/Tarektouati/codex-cursor-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Tarektouati/codex-cursor-bridge/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@tarektweeti/codex-cursor-bridge)](package.json)
[![license](https://img.shields.io/github/license/Tarektouati/codex-cursor-bridge)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/Tarektouati/codex-cursor-bridge/pulls)

A local proxy that lets the [OpenAI Codex CLI](https://github.com/openai/codex)
run on your Cursor subscription's models instead of OpenAI's. It implements the
OpenAI **Responses API** (`POST /v1/responses`) that Codex speaks, and backs it
with [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript).

No Codex source changes are needed: Codex already supports pointing at any
Responses-API-compatible endpoint through `~/.codex/config.toml`. This bridge is
the translation layer in between.

```
Codex CLI  ──POST /v1/responses (SSE)──▶  bridge  ──@cursor/sdk──▶  Cursor model
   ▲                                          │
   └────────── function_call / result ────────┘   (Codex keeps its own sandbox)
```

## How it works

Cursor's SDK is an **agent** SDK, not a raw model endpoint — Cursor states this
explicitly on [cursor.com/docs/api](https://cursor.com/docs/api). A Cursor agent
runs its own tool loop (read, edit, shell) against a working directory. Left
alone it would do the file edits itself and reduce Codex to a dumb terminal,
bypassing Codex's sandbox and approvals.

The bridge inverts that so **Codex keeps ownership of the tool loop**:

1. It creates a Cursor local agent with `tools: ["mcp"]`, which drops every
   built-in tool (shell/read/edit/...) while keeping the MCP capability group
   that carries custom tools.
2. It registers **Codex's own tools** as Cursor `customTools`. When the Cursor
   model calls one, the tool's `execute()` blocks on a promise.
3. The bridge emits that call to Codex as a Responses `function_call` item and
   ends the HTTP turn — while the Cursor run stays alive.
4. Codex runs the tool in its own sandbox and sends the result on its next
   request. The bridge resolves the parked promise, and the same Cursor run
   continues.

This means Codex's sandbox, approval policy, and TUI all keep working normally.

## Requirements

- **Node.js ≥ 22.13** (required by `@cursor/sdk`; CI tests Node 22 and 24)
- Codex CLI (developed against `codex-cli 0.140.0`)
- A Cursor API key: [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations)

## Quick start

No clone needed. Requires Node.js ≥ 22.13.

```sh
export CURSOR_API_KEY="cursor_..."        # your Cursor key, passed to the SDK
export CURSOR_BRIDGE_KEY="some-secret"     # shared secret Codex presents

npx @tarektweeti/codex-cursor-bridge catalog   # once: writes ~/.codex/cursor-bridge-models.json
npx @tarektweeti/codex-cursor-bridge           # starts the bridge on http://127.0.0.1:4712/v1
```

Prefer a global install? `npm i -g @tarektweeti/codex-cursor-bridge` gives you a
`codex-cursor-bridge` command. Run `codex-cursor-bridge --help` for all options.
A `.env` file in the current directory is loaded automatically; variables
already set in your shell take precedence.

`catalog` queries your Cursor account and writes an account-specific model
catalog to `$CODEX_HOME` (default `~/.codex`). Use `--out <path>` to write
it somewhere else.

## Point Codex at the bridge

Save this as `~/.codex/cursor-bridge.config.toml`:

```toml
model = "composer-2.5"
model_provider = "cursor-bridge"
model_catalog_json = "/Users/you/.codex/cursor-bridge-models.json"  # path printed by `catalog`

[model_providers.cursor-bridge]
name = "Cursor Bridge"
base_url = "http://127.0.0.1:4712/v1"
env_key = "CURSOR_BRIDGE_KEY"
wire_api = "responses"

[features]
multi_agent = false
```

`-p NAME` layers `$CODEX_HOME/NAME.config.toml` over your base config, so your
main `~/.codex/config.toml` is left untouched:

```sh
export CURSOR_BRIDGE_KEY="some-secret"     # must match the bridge's value
codex exec -p cursor-bridge "Reply with exactly CURSOR_BACKEND_OK and say which model you are."
codex -p cursor-bridge                      # interactive TUI
```

The `model_catalog_json` entry silences Codex's "model metadata not found"
warning and gives Codex's picker the list of models to show. It **replaces**
Codex's built-in catalog, so only models listed there appear in Codex — though
the bridge itself never restricts models and will run any id you set in `model`.

The catalog is account-specific and changes as models ship, so re-run
`npx @tarektweeti/codex-cursor-bridge catalog` instead of editing it by hand. It
writes every concrete model from `Cursor.models.list()`, with `composer-2.5`
first as the default.

## Configuration

All configuration is via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CURSOR_API_KEY` | (required) | Cursor credential, passed to `@cursor/sdk`. |
| `CURSOR_BRIDGE_KEY` | (unset) | Shared secret; when set, Codex must present it as `Authorization: Bearer`. Required to bind off-loopback. |
| `BRIDGE_HOST` | `127.0.0.1` | Listen host. Non-loopback requires `CURSOR_BRIDGE_KEY`. |
| `BRIDGE_PORT` | `4712` | Listen port. |
| `BRIDGE_MODEL` | `composer-2.5` | Model used when a request omits one. |
| `BRIDGE_CWD` | `process.cwd()` | Fallback working directory for the Cursor agent (Codex's advertised `cwd` overrides it). |
| `BRIDGE_STREAM_THINKING` | `true` | Forward Cursor thinking deltas as Responses reasoning summaries. |
| `BRIDGE_TOOL_BATCH_MS` | `50` | Window for collecting parallel tool calls into one batch. |
| `BRIDGE_SESSION_IDLE_MS` | `1800000` | Idle timeout before a session's agent is disposed. |
| `BRIDGE_SYSTEM_PROMPT` | `0` | Set `1` to try the account-gated `systemPrompt` option (see below). |
| `BRIDGE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. |
| `BRIDGE_DUMP_DIR` | (unset) | If set, raw Responses requests are written here as JSON (debugging). |

## Development

Running from a clone:

```sh
git clone https://github.com/Tarektouati/codex-cursor-bridge.git
cd codex-cursor-bridge
npm install
npm start             # runs src/ directly through tsx
```

```sh
npm run build         # compile to dist/ (what gets published)
npm run typecheck     # tsc --noEmit
npm test              # offline unit + HTTP contract tests (no network)
npm run smoke         # live SDK probe (needs CURSOR_API_KEY)
npm run gen:catalog   # write codex/model-catalog.json (gitignored) from your account
```

- [`test/unit/`](test/unit) covers request translation, tool mapping, and the
  full SSE frame contract against a stubbed Cursor agent — including the tool
  round trip that resumes a parked run. No network.
- [`scripts/smoke-sdk.ts`](scripts/smoke-sdk.ts) probes the real SDK: that
  `tools: ["mcp"]` keeps custom tools, that text streams incrementally, and that
  a deferred tool result resumes the same run.
- [`scripts/probe-roundtrip.ts`](scripts/probe-roundtrip.ts) drives a full
  two-request tool round trip against a running bridge.
- [`scripts/bridge.sh`](scripts/bridge.sh) starts/stops the bridge detached.

## Design notes and pinned wire-format facts

These are what the bridge is built against; they are the traps that break a
hand-written Responses proxy silently:

- **Codex is stateless.** It sets `store: false`, never sends
  `previous_response_id`, and resends the full conversation every request. The
  bridge holds all session state, keyed on `prompt_cache_key` (Codex's thread
  id), falling back to the `thread-id` header.
- **Only `response.completed` is mandatory**, and its `response.id` is required.
  If `usage` is included, `input_tokens`/`output_tokens`/`total_tokens` are all
  required — a partial `usage` object fails the whole frame. The bridge omits
  `usage`.
- **Never emit `response.function_call_arguments.*`** — Codex 0.140 ignores
  them. Each tool call is one `response.output_item.done`.
- **Never return HTTP 429** — Codex does not retry it. Backpressure is a
  `response.failed` with `code: "rate_limit_exceeded"` and a `try again in Ns`
  message, which Codex does honour.
- **Reasoning items must be opened** with `response.output_item.added` before any
  summary part/delta, or Codex logs "without active item" and drops them.

## Known limitations

- **`systemPrompt` is account-gated.** Cursor's own harness prompt can only be
  replaced with the `systemPrompt` option if your account has access; without it
  the first `send()` fails with `unknown option '--system-prompt'`. The bridge
  defaults to **not** using it and instead delivers Codex's `instructions` as the
  opening user message with a preamble that tells the model to ignore its
  built-in tool vocabulary. Set `BRIDGE_SYSTEM_PROMPT=1` to try the option; the
  bridge falls back automatically if it's rejected.
- **First-call argument mismatches.** A Cursor model driving Codex's tool
  schemas may produce slightly wrong arguments on its first tool call (e.g. a
  `missing field cmd` router error), then self-correct on retry. This is
  model-side; the bridge relays the error back faithfully and the model recovers.
- **One run per session, serialized.** Concurrent `send()` on a single local
  agent is undocumented; turns within a conversation are queued.
- **Local runtime only.** Cloud Cursor agents, image input, and MCP bridging
  beyond Codex's own tool calls are out of scope.
- **Transitive advisories.** `npm audit` reports advisories via
  `@cursor/sdk → @connectrpc/connect-node → undici`. No compatible fix is
  published upstream at the pinned SDK version.

## Terms of service

Cursor's [Acceptable Use Policy](https://cursor.com/acceptable-use-policy)
prohibits "accessing the Service through automated or non-human means, whether
through a bot, script, or otherwise," which — read literally — also describes the
SDK's own documented purpose. Cursor staff have stated publicly that scripts, CI,
and automation are what the SDK is built for, and the resale clause
([ToS §1.5](https://cursor.com/terms-of-service)) is aimed at repackaging Cursor
access for third parties. A single-user, local, personal bridge sits well inside
that line.

However, the AUP text and the SDK docs genuinely contradict each other, and the
SDK is in **public beta** — ToS §1.6 states beta services are "not for
production use." Use this at your own discretion; if your use approaches
reselling or multi-user access, get written confirmation from Cursor.

## License

This project is licensed under the [MIT License](LICENSE).
