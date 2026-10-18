/**
 * Verifies every registered workflow's param targets resolve against its graph.
 * Run after editing a workflow file or swapping in a new ComfyUI export:
 *
 *   pnpm check:workflows
 */
import { validateWorkflow } from "../src/lib/params";
import { WORKFLOWS } from "../src/lib/workflows";
import { collect } from "../src/lib/workflows/needs";
import { MODEL_SOURCES } from "./lib/model-sources";
import { readFileSync } from "node:fs";
import {
  buildRequirements,
  serializeRequirements,
} from "../src/lib/workflows/requirements";

let failed = false;

for (const workflow of WORKFLOWS) {
  const problems = validateWorkflow(workflow);
  const nodeCount = Object.keys(workflow.graph).length;
  const spliced = [
    ...(workflow.turbo ? ["turbo"] : []),
    ...(workflow.patches ?? []).map((patch) => patch.id),
  ];

  if (problems.length === 0) {
    console.log(
      `  ok   ${workflow.id} — ${workflow.params.length} params over ${nodeCount} nodes` +
        // validateWorkflow proves the splices work as well as the targets do —
        // each on its own, and all of them stacked.
        (spliced.length > 0 ? `, ${spliced.join(" + ")} splice cleanly` : "") +
        (workflow.stepSampler
          ? `, ${workflow.stepSampler.atValue}-step sampler resolves`
          : "") +
        // Only where there are any: most graphs have nothing for `finalize` to
        // branch on, and a "0 cases" on every line would read as a gap.
        (workflow.finalizeCases?.length
          ? `, ${workflow.finalizeCases.length} finalize cases queue cleanly`
          : ""),
    );
    continue;
  }

  failed = true;
  console.error(`  FAIL ${workflow.id}`);
  for (const problem of problems) console.error(`       ${problem}`);
}

// Every file a graph can name has to say where it comes from, or
// `models:download` cannot fetch it and a new workflow ships with a download
// nobody can find.
const unsourced = [...collect().models.keys()].filter(
  (file) => !(file in MODEL_SOURCES),
);
if (unsourced.length > 0) {
  failed = true;
  console.error("  FAIL model sources");
  for (const file of unsourced) {
    console.error(
      `       ${file} is named by a graph but has no entry in scripts/lib/model-sources.ts`,
    );
  }
}

// The manifest the update runbook and the app read. Stale, it would tell an
// update that needs the ComfyUI machine that it does not.
let written = "";
try {
  written = readFileSync("machine-requirements.json", "utf8");
} catch {
  // Missing reads as stale.
}
if (written !== serializeRequirements(buildRequirements())) {
  failed = true;
  console.error("  FAIL machine-requirements.json");
  console.error(
    "       is stale — run `pnpm requirements:write` and commit the result",
  );
}

if (failed) {
  console.error(
    "\nOne or more workflows are out of sync with their graph. Fix the declaration in the workflow file — the `targets`, or whichever rule the line above names.",
  );
  process.exit(1);
}

console.log(`\n${WORKFLOWS.length} workflow(s) valid.`);
