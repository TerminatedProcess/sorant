/**
 * Downloads the model files the chosen workflows need, into a ComfyUI install.
 *
 *   pnpm models:download --comfy <ComfyUI folder>                     # what each workflow needs, and what is already there
 *   pnpm models:download --comfy <dir> --workflows minimax-h3,minimax-music3
 *   pnpm models:download --comfy <dir> --workflows all --extras local-director
 *   pnpm models:download --comfy <dir> --workflows all --skip minimax_h3_ref2va_bf16.safetensors
 *
 * Run it on the ComfyUI machine. Which files a workflow needs comes from the
 * graphs themselves (src/lib/workflows/needs.ts, the same list `check:nodes` asks
 * about), and where each comes from is scripts/lib/model-sources.ts.
 *
 * A file already in place at the right size is skipped. A partial download is
 * resumed from where it stopped, so an interrupted run is safe to repeat. Set
 * HF_TOKEN for the gated FLUX Kontext file, after accepting its licence on
 * Hugging Face with the same account.
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  statfsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WORKFLOWS } from "../src/lib/workflows";
import { collect } from "../src/lib/workflows/needs";
import { EXTRAS, MODEL_SOURCES } from "./lib/model-sources";

interface Args {
  comfy?: string;
  modelsDir?: string;
  workflows: string[];
  extras: string[];
  skip: string[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { workflows: [], extras: [], skip: [], dryRun: false };
  const list = (value: string | undefined) =>
    (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--comfy") (args.comfy = value), i++;
    else if (flag === "--models-dir") (args.modelsDir = value), i++;
    else if (flag === "--workflows") (args.workflows = list(value)), i++;
    else if (flag === "--extras") (args.extras = list(value)), i++;
    else if (flag === "--skip") (args.skip = list(value)), i++;
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--") continue;
    else {
      console.error(`Unknown argument: ${flag}`);
      process.exit(2);
    }
  }
  return args;
}

const gb = (bytes: number) =>
  bytes < 1e9 ? `${Math.round(bytes / 1e6)} MB` : `${(bytes / 1e9).toFixed(1)} GB`;

/** Required files per workflow id, read off the graphs. */
function requiredByWorkflow(): Map<string, Set<string>> {
  const byWorkflow = new Map<string, Set<string>>(
    WORKFLOWS.map((w) => [w.id, new Set<string>()]),
  );
  for (const [file, need] of collect().models) {
    if (need.optional) continue;
    // Labels are "<workflow id>" or "<workflow id> (<form>)".
    for (const label of need.workflows) {
      byWorkflow.get(label.split(" ")[0])?.add(file);
    }
  }
  return byWorkflow;
}

function pathFor(modelsDir: string, file: string): string {
  return join(modelsDir, MODEL_SOURCES[file].folder, file);
}

/** Present means the right size: a short file is a download that stopped. */
function isPresent(modelsDir: string, file: string): boolean {
  const target = pathFor(modelsDir, file);
  return existsSync(target) && statSync(target).size === MODEL_SOURCES[file].bytes;
}

async function download(modelsDir: string, file: string): Promise<void> {
  const source = MODEL_SOURCES[file];
  const target = pathFor(modelsDir, file);
  const partial = `${target}.part`;
  mkdirSync(join(modelsDir, source.folder), { recursive: true });

  const have = existsSync(partial) ? statSync(partial).size : 0;
  const headers: Record<string, string> = {};
  if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
  if (have > 0) headers.Range = `bytes=${have}-`;

  const url = `https://huggingface.co/${source.repo}/resolve/main/${source.path}`;
  const response = await fetch(url, { headers, redirect: "follow" });
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      source.gated
        ? `${file} is gated. Accept the licence at https://huggingface.co/${source.repo} ` +
            "while signed in, then set HF_TOKEN to a token from that account and run this again."
        : `Hugging Face refused ${file} (${response.status}). Set HF_TOKEN and try again.`,
    );
  }
  if (!response.ok || !response.body) {
    throw new Error(`${file}: HTTP ${response.status} from ${url}`);
  }
  // A server that ignored the Range header is sending the whole file again.
  const resuming = have > 0 && response.status === 206;

  let written = resuming ? have : 0;
  let lastReport = 0;
  const body = Readable.fromWeb(response.body as never);
  body.on("data", (chunk: Buffer) => {
    written += chunk.length;
    const now = Date.now();
    if (now - lastReport > 5000) {
      lastReport = now;
      const pct = ((written / source.bytes) * 100).toFixed(0);
      console.log(`    ${file}: ${gb(written)} of ${gb(source.bytes)} (${pct}%)`);
    }
  });
  await pipeline(body, createWriteStream(partial, { flags: resuming ? "a" : "w" }));

  const size = statSync(partial).size;
  if (size !== source.bytes) {
    throw new Error(
      `${file} finished at ${size} bytes, expected ${source.bytes}. ` +
        "Run this again to resume it.",
    );
  }
  renameSync(partial, target);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.comfy && !args.modelsDir) {
    console.error(
      "Pass --comfy <your ComfyUI folder> (the one containing main.py and models/),\n" +
        "or --models-dir <path> if your models live elsewhere (extra_model_paths.yaml).",
    );
    process.exit(2);
  }
  const modelsDir = resolve(args.modelsDir ?? join(args.comfy!, "models"));
  if (!existsSync(modelsDir)) {
    console.error(`No models folder at ${modelsDir}. Is --comfy the ComfyUI folder?`);
    process.exit(2);
  }

  const byWorkflow = requiredByWorkflow();

  // No selection: show what each choice costs and what is already there.
  if (args.workflows.length === 0 && args.extras.length === 0) {
    console.log(`Models folder: ${modelsDir}\n\nWorkflows (--workflows, comma-separated, or all):`);
    for (const workflow of WORKFLOWS) {
      const files = [...(byWorkflow.get(workflow.id) ?? [])];
      const missing = files.filter((f) => !isPresent(modelsDir, f));
      const bytes = missing.reduce((n, f) => n + MODEL_SOURCES[f].bytes, 0);
      console.log(
        `  ${workflow.id.padEnd(18)} ${workflow.name.padEnd(20)} ` +
          (missing.length ? `${missing.length} file(s) missing, ${gb(bytes)}` : "all present"),
      );
    }
    console.log("\nExtras (--extras):");
    for (const [id, extra] of Object.entries(EXTRAS)) {
      const missing = extra.files.filter((f) => !isPresent(modelsDir, f));
      const bytes = missing.reduce((n, f) => n + MODEL_SOURCES[f].bytes, 0);
      console.log(
        `  ${id.padEnd(18)} ${extra.what} — ` +
          (missing.length ? gb(bytes) : "present"),
      );
    }
    console.log(
      "\nFiles shared between workflows are counted under each; downloading several\n" +
        "costs less than the sum. Add --dry-run to see the exact total first.",
    );
    return;
  }

  const wanted = new Set<string>();
  const ids =
    args.workflows.includes("all") ? WORKFLOWS.map((w) => w.id) : args.workflows;
  for (const id of ids) {
    const files = byWorkflow.get(id);
    if (!files) {
      console.error(`Unknown workflow "${id}". Known: ${WORKFLOWS.map((w) => w.id).join(", ")}`);
      process.exit(2);
    }
    files.forEach((f) => wanted.add(f));
  }
  for (const id of args.extras) {
    const extra = EXTRAS[id];
    if (!extra) {
      console.error(`Unknown extra "${id}". Known: ${Object.keys(EXTRAS).join(", ")}`);
      process.exit(2);
    }
    extra.files.forEach((f) => wanted.add(f));
  }
  for (const file of args.skip) wanted.delete(file);

  const missing = [...wanted].filter((f) => !isPresent(modelsDir, f));
  const total = missing.reduce((n, f) => n + MODEL_SOURCES[f].bytes, 0);
  const free = (() => {
    const stats = statfsSync(modelsDir);
    return stats.bavail * stats.bsize;
  })();

  console.log(`Models folder: ${modelsDir}`);
  console.log(`${wanted.size - missing.length} of ${wanted.size} file(s) already present.`);
  for (const file of missing) {
    const source = MODEL_SOURCES[file];
    console.log(
      `  get  ${source.folder}/${file}  ${gb(source.bytes)}${source.gated ? "  (gated: needs HF_TOKEN)" : ""}`,
    );
  }
  console.log(`To download: ${gb(total)}. Free on that drive: ${gb(free)}.`);

  if (total > free) {
    console.error("\nNot enough free space. Choose fewer workflows, or use --skip.");
    process.exit(1);
  }
  const gated = missing.filter((f) => MODEL_SOURCES[f].gated);
  if (gated.length > 0 && !process.env.HF_TOKEN) {
    console.error(
      `\n${gated.join(", ")} is gated and HF_TOKEN is not set. Accept the licence at ` +
        `https://huggingface.co/${MODEL_SOURCES[gated[0]].repo}, create a read token at ` +
        "https://huggingface.co/settings/tokens, set HF_TOKEN, and run this again — " +
        "or add --skip for it to download everything else.",
    );
    process.exit(1);
  }
  if (args.dryRun || missing.length === 0) return;

  const failures: string[] = [];
  for (const [i, file] of missing.entries()) {
    console.log(`\n[${i + 1}/${missing.length}] ${file}`);
    try {
      await download(modelsDir, file);
      console.log("    done");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    FAILED: ${message}`);
      failures.push(file);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} file(s) failed: ${failures.join(", ")}. Run the same command again to retry.`);
    process.exit(1);
  }
  console.log("\nAll files in place. Restart ComfyUI if it was running, then run pnpm check:nodes.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
