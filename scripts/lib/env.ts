import { readFileSync } from "node:fs";

/**
 * Next loads .env.local for the app; a bare tsx process gets nothing, so the
 * scripts do it here. Never overwrites anything already in the environment,
 * which is what lets CI pass COMFY_URL without a file on disk.
 *
 * Split on CRLF as well as LF: a .env.local written from PowerShell has Windows
 * line endings, and a `.` in the pattern below does not match `\r`, so every
 * line would fail and the script would report COMFY_URL unset in a file that
 * plainly sets it — while the app, on Next's own loader, works fine.
 */
export function loadEnvFiles(): void {
  for (const file of [".env.local", ".env"]) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const [, key, rest] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rest
        .replace(/^["']|["']$/g, "")
        // dotenv turns an escaped \$ into a literal $, and the ComfyUI token is
        // full of them. Matching that here is what keeps these scripts
        // authenticating the same way the app does.
        .replace(/\\\$/g, "$");
    }
  }
}
