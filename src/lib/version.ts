import pkg from "../../package.json";
import requirements from "../../machine-requirements.json";

/**
 * This build's version, from package.json, and the fingerprint of what it
 * needs from the ComfyUI machine. Server-only: package.json carries the whole
 * dependency list, which has no business in a client bundle.
 */
export const APP_VERSION: string = pkg.version;
export const MACHINE_FINGERPRINT: string = requirements.fingerprint;

/** The repo releases are published from. */
export const RELEASE_REPO = "pwillia7/sorant";

/** "v0.10.2" > "0.9.9". Anything unparseable compares as equal, so it never nags. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10));
  const a = parse(candidate);
  const b = parse(current);
  if ([...a, ...b].some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
