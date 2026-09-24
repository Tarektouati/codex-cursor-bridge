/**
 * Regenerates codex/model-catalog.json from the live Cursor catalog.
 *
 * Run: CURSOR_API_KEY=... npm run gen:catalog
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { reportCatalog, writeCatalog } from "../src/catalog.js";

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "codex",
  "model-catalog.json",
);

const apiKey = process.env.CURSOR_API_KEY?.trim();
if (!apiKey) {
  throw new Error(
    "CURSOR_API_KEY must be set (https://cursor.com/dashboard/integrations)",
  );
}

reportCatalog(OUT, await writeCatalog(apiKey, OUT));
