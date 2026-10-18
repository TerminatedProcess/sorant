"use client";

import { useEffect, useState } from "react";
import type { UpdateInfo } from "@/app/api/updates/route";
import { Dot } from "@/components/ui/panel";
import { api } from "@/lib/client";

/**
 * A newer release, in the header — once per page load, and nothing at all
 * while there is none. It says which kind of update it is, because that is
 * what decides where it can be done: an app-only release can be deployed from
 * any machine, one that changes what the ComfyUI machine needs has to be run
 * there first. The link is the release notes, which carry the prompt to paste.
 */
export function UpdateBadge() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

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

  const latest = info?.latest;
  if (!info || !latest) return null;

  const where =
    latest.machineChanges === false
      ? "App-only update: it can be deployed from any machine."
      : latest.machineChanges === true
        ? "It also needs changes on your ComfyUI machine, so run the update there."
        : "Check the release notes for anything it needs on your ComfyUI machine.";

  return (
    <a
      href={latest.url}
      target="_blank"
      rel="noreferrer"
      title={`Soran’t ${latest.version} is out (this is ${info.current}). ${where}`}
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
