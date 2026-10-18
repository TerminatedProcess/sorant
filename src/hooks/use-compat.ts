"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { CompatReport } from "@/lib/compat";

/**
 * Whether the ComfyUI machine has what each workflow needs — see
 * src/lib/compat.ts. Asked when the machine is first reachable and again every
 * few minutes, since installing a pack means a ComfyUI restart and nobody
 * reloads the page for that. The server caches the answer, so the interval
 * costs it nothing.
 */
export function useCompat(reachable: boolean): CompatReport | null {
  const [report, setReport] = useState<CompatReport | null>(null);

  useEffect(() => {
    if (!reachable) return;
    let cancelled = false;
    const check = async () => {
      try {
        const next = await api<CompatReport>("/api/compat");
        if (!cancelled && next.checked) setReport(next);
      } catch {
        // Keep the last answer; the connection pill says what is wrong.
      }
    };
    void check();
    const id = setInterval(check, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [reachable]);

  return report;
}
