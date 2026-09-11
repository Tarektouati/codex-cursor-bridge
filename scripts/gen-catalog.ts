/**
 * Regenerates codex/model-catalog.json from the live Cursor catalog.
 *
 * `Cursor.models.list()` is account- and team-specific and changes as models
 * ship, so a hand-maintained list goes stale. Codex consumes a catalog with a
 * fixed field set (a missing field such as `supports_reasoning_summaries` makes
 * it refuse the file), so each entry is emitted with every field populated.
 *
 * Run: CURSOR_API_KEY=... npm run gen:catalog
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Cursor, type ModelListItem } from "@cursor/sdk";

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "codex",
  "model-catalog.json",
);

/** One Codex catalog entry. Field set matches what Codex 0.140 requires. */
interface CatalogEntry {
  base_instructions: string;
  context_window: number;
  default_verbosity: string;
  display_name: string;
  experimental_supported_tools: string[];
  input_modalities: string[];
  priority: number;
  shell_type: string;
  slug: string;
  support_verbosity: boolean;
  supported_in_api: boolean;
  supported_reasoning_levels: string[];
  supports_parallel_tool_calls: boolean;
  supports_reasoning_summaries: boolean;
  truncation_policy: { limit: number; mode: string };
  visibility: string;
}

function toEntry(model: ModelListItem, priority: number): CatalogEntry {
  return {
    base_instructions: "",
    // Cursor doesn't publish per-model context windows through the SDK catalog,
    // so use a conservative default; it only affects Codex's local budgeting.
    context_window: 200_000,
    default_verbosity: "medium",
    display_name: model.displayName || model.id,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    priority,
    shell_type: "default",
    slug: model.id,
    support_verbosity: false,
    supported_in_api: true,
    supported_reasoning_levels: [],
    // The bridge sends parallel_tool_calls-agnostic requests and Codex's own
    // tool router serializes anyway; keep these off to avoid surprising Codex.
    supports_parallel_tool_calls: false,
    supports_reasoning_summaries: false,
    truncation_policy: { limit: 10_000, mode: "bytes" },
    visibility: "list",
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "CURSOR_API_KEY must be set (https://cursor.com/dashboard/integrations)",
    );
  }

  const models = await Cursor.models.list({ apiKey });
  // Skip meta-selectors that aren't concrete models Codex should list.
  const skip = new Set(["default", "auto", "auto-smart"]);
  const usable = models.filter((m) => !skip.has(m.id));

  // Keep composer-2.5 first so it stays the natural default, then alphabetical.
  usable.sort((a, b) => {
    if (a.id === "composer-2.5") return -1;
    if (b.id === "composer-2.5") return 1;
    return a.id.localeCompare(b.id);
  });

  const catalog = { models: usable.map((m, i) => toEntry(m, i)) };
  await writeFile(OUT, `${JSON.stringify(catalog, null, 2)}\n`);

  console.log(`wrote ${usable.length} models to ${OUT}`);
  console.log(`  ${usable.map((m) => m.id).join(", ")}`);
  if (skip.size > 0) {
    const skipped = models.filter((m) => skip.has(m.id)).map((m) => m.id);
    if (skipped.length > 0) {
      console.log(`  (skipped meta-selectors: ${skipped.join(", ")})`);
    }
  }
}

await main();
