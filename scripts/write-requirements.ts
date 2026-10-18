/**
 * Writes machine-requirements.json: what this version of the app needs from
 * the ComfyUI machine. Run after touching anything under src/lib/workflows/ —
 * `check:workflows` fails while the file is stale.
 *
 *   pnpm requirements:write
 *
 * See src/lib/workflows/requirements.ts for why the file exists.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildRequirements,
  serializeRequirements,
} from "../src/lib/workflows/requirements";

const FILE = "machine-requirements.json";

const next = serializeRequirements(buildRequirements());
let current = "";
try {
  current = readFileSync(FILE, "utf8");
} catch {
  // First write.
}

if (current === next) {
  console.log(`${FILE} is up to date.`);
} else {
  writeFileSync(FILE, next);
  const { fingerprint } = JSON.parse(next) as { fingerprint: string };
  console.log(`Wrote ${FILE} (fingerprint ${fingerprint}).`);
}
