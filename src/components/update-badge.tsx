"use client";

import { useCallback, useEffect, useState } from "react";
import type { UpdateInfo } from "@/app/api/updates/route";
import { Dot } from "@/components/ui/panel";
import { api } from "@/lib/client";

export interface Updates {
  info: UpdateInfo | null;
  /** Asks GitHub now rather than the server's six-hour answer. */
  check: () => Promise<void>;
  checking: boolean;
  /** When the last check this page asked for finished — null until one has. */
  checkedAt: number | null;
}

/**
 * This deployment's version, and any newer release. Asked once per page load;
 * `check` asks again, live. Held by the page and handed to both the header
 * notice and the status panel, so a check from the panel updates the notice.
 */
export function useUpdates(): Updates {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<UpdateInfo>("/api/updates")
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch(() => {
        // No notice is the right failure.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setInfo(await api<UpdateInfo>("/api/updates?refresh=1"));
      setCheckedAt(Date.now());
    } catch {
      // Leave the last answer standing.
    } finally {
      setChecking(false);
    }
  }, []);

  return { info, check, checking, checkedAt };
}

/** Where an update can be done, in one sentence. */
export function updateWhere(machineChanges: boolean | null): string {
  return machineChanges === false
    ? "App-only update: it can be deployed from any machine."
    : machineChanges === true
      ? "It also needs changes on your ComfyUI machine, so run the update there."
      : "Check the release notes for anything it needs on your ComfyUI machine.";
}

/**
 * A newer release, in the header — nothing at all while there is none. It
 * says which kind of update it is, because that is what decides where it can
 * be done: an app-only release can be deployed from any machine, one that
 * changes what the ComfyUI machine needs has to be run there first. The link
 * is the release notes, which carry the prompt to paste.
 */
export function UpdateBadge({ info }: { info: UpdateInfo | null }) {
  const latest = info?.latest;
  if (!info || !latest) return null;

  return (
    <a
      href={latest.url}
      target="_blank"
      rel="noreferrer"
      title={`Soran’t ${latest.version} is out (this is ${info.current}). ${updateWhere(latest.machineChanges)}`}
      className="inline-flex items-center gap-2 rounded-full border border-border-default
        bg-surface px-2.5 py-1 text-[12px] text-fg-muted transition-colors duration-150
        hover:border-border-strong hover:bg-surface-hover"
    >
      <Dot tone={latest.machineChanges === false ? "accent" : "warning"} />
      <span className="font-medium text-fg">
        <span className="hidden sm:inline">Update </span>
        {latest.version}
      </span>
    </a>
  );
}
