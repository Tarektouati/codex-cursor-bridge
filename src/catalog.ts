/**
 * Builds a Codex model catalog from the live Cursor catalog.
 *
 * `Cursor.models.list()` is account- and team-specific and changes as models
 * ship, so a hand-maintained list goes stale. Codex consumes a catalog with a
 * fixed field set (a missing field such as `supports_reasoning_summaries` makes
 * it refuse the file), so each entry is emitted with every field populated.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Cursor, type ModelListItem } from "@cursor/sdk";

/** One Codex catalog entry. Field set matches what Codex 0.140 requires. */
export interface CatalogEntry {
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

/** Meta-selectors that aren't concrete models Codex should list. */
const META_SELECTORS = new Set(["default", "auto", "auto-smart"]);

export interface CatalogResult {
  catalog: { models: CatalogEntry[] };
  /** Meta-selector ids present in the account but left out of the catalog. */
  skipped: string[];
}

export async function generateCatalog(apiKey: string): Promise<CatalogResult> {
  const models = await Cursor.models.list({ apiKey });
  const usable = models.filter((m) => !META_SELECTORS.has(m.id));

  // Keep composer-2.5 first so it stays the natural default, then alphabetical.
  usable.sort((a, b) => {
    if (a.id === "composer-2.5") return -1;
    if (b.id === "composer-2.5") return 1;
    return a.id.localeCompare(b.id);
  });

  return {
    catalog: { models: usable.map((m, i) => toEntry(m, i)) },
    skipped: models.filter((m) => META_SELECTORS.has(m.id)).map((m) => m.id),
  };
}

/** Generates the catalog and writes it to `path`, creating parent dirs. */
export async function writeCatalog(
  apiKey: string,
  path: string,
): Promise<CatalogResult> {
  const result = await generateCatalog(apiKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(result.catalog, null, 2)}\n`);
  return result;
}

/** Prints a short summary of a written catalog. */
export function reportCatalog(path: string, result: CatalogResult): void {
  const ids = result.catalog.models.map((m) => m.slug);
  console.log(`wrote ${ids.length} models to ${path}`);
  console.log(`  ${ids.join(", ")}`);
  if (result.skipped.length > 0) {
    console.log(`  (skipped meta-selectors: ${result.skipped.join(", ")})`);
  }
}
