import { unauthorized } from "@/lib/auth";
import {
  APP_VERSION,
  isNewer,
  MACHINE_FINGERPRINT,
  RELEASE_REPO,
} from "@/lib/version";

export const dynamic = "force-dynamic";

/** Six hours: a release is not urgent, and GitHub allows 60 unauthenticated calls an hour. */
const RELEASE_TTL_S = 6 * 60 * 60;

/**
 * "Check for updates" skips the six hours — at most once a minute per server,
 * so a button pressed repeatedly cannot spend the hour's allowance. Inside the
 * minute it gets the cached answer, which is at most a minute old anyway.
 */
const LIVE_CHECK_GAP_MS = 60_000;
let lastLiveCheck = 0;

export interface UpdateInfo {
  current: string;
  /** What this build needs from the ComfyUI machine — see machine-requirements.json. */
  fingerprint: string;
  /** Null when there is nothing newer, or the check is off or failed. */
  latest: {
    version: string;
    url: string;
    /**
     * Whether the newer release needs anything new on the ComfyUI machine.
     * Null when its manifest could not be read — the notice then says to
     * check, rather than guessing either way.
     */
    machineChanges: boolean | null;
  } | null;
}

/**
 * This deployment's version, and whether a newer release is out.
 *
 * Asked server-side, so the browser never talks to GitHub, and cached, so a
 * deployment asks a few times a day however many people use it. Every failure
 * reads as "nothing newer": a notice that is sometimes missing costs nothing,
 * one that is sometimes wrong teaches people to ignore it. Off with
 * SORANT_UPDATE_CHECK=off. `?refresh=1` asks GitHub now — see below.
 *
 * Also how an updating agent learns what is deployed, when the clone it is
 * working in is not the one the deployment was built from.
 */
export async function GET(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  const info: UpdateInfo = {
    current: APP_VERSION,
    fingerprint: MACHINE_FINGERPRINT,
    latest: null,
  };
  if (process.env.SORANT_UPDATE_CHECK === "off") return Response.json(info);

  const live =
    new URL(request.url).searchParams.get("refresh") === "1" &&
    Date.now() - lastLiveCheck > LIVE_CHECK_GAP_MS;
  if (live) lastLiveCheck = Date.now();

  try {
    const response = await fetch(
      `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "sorant" },
        ...(live ? { cache: "no-store" as const } : { next: { revalidate: RELEASE_TTL_S } }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) return Response.json(info);
    const release = (await response.json()) as { tag_name?: string; html_url?: string };
    const tag = release.tag_name;
    if (!tag || !release.html_url || !isNewer(tag, APP_VERSION)) {
      return Response.json(info);
    }

    // The release's own manifest says whether it needs the ComfyUI machine.
    // A tag never moves, so this is cached for as long as Next will hold it.
    let machineChanges: boolean | null = null;
    try {
      const manifest = await fetch(
        `https://raw.githubusercontent.com/${RELEASE_REPO}/${encodeURIComponent(tag)}/machine-requirements.json`,
        { next: { revalidate: false }, signal: AbortSignal.timeout(5_000) },
      );
      if (manifest.ok) {
        const { fingerprint } = (await manifest.json()) as { fingerprint?: string };
        if (fingerprint) machineChanges = fingerprint !== MACHINE_FINGERPRINT;
      }
    } catch {
      // Unknown, not "none".
    }

    info.latest = {
      version: tag.replace(/^v/, ""),
      url: release.html_url,
      machineChanges,
    };
  } catch {
    // Offline, rate limited, GitHub down: say nothing.
  }
  return Response.json(info);
}
