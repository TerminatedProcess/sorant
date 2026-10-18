"use client";

import type { Health } from "@/components/connection-pill";
import { updateWhere, type Updates } from "@/components/update-badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Dot } from "@/components/ui/panel";
import type { CompatReport } from "@/lib/compat";
import type { WorkflowSummary } from "@/lib/workflows/types";

const UPDATING =
  "https://github.com/pwillia7/sorant/blob/main/README.md#updating";

/**
 * Everything the header pill knows, opened from it: the ComfyUI connection,
 * whether that machine has what the workflows need, and this app's version
 * with a way to check for a newer one. A panel rather than the tooltip it
 * replaces, because a tooltip is invisible on a phone — and a version number
 * is something people go looking for only when they need it.
 */
export function StatusPanel({
  open,
  onClose,
  health,
  compat,
  updates,
  workflows,
}: {
  open: boolean;
  onClose: () => void;
  health: Health | null;
  compat: CompatReport | null;
  updates: Updates;
  workflows: WorkflowSummary[];
}) {
  return (
    <Modal open={open} onClose={onClose} title="Status">
      <Section title="ComfyUI">
        <ComfyStatus health={health} />
      </Section>
      <Section title="Your ComfyUI machine">
        <MachineStatus compat={compat} health={health} workflows={workflows} />
      </Section>
      <Section title="Soran’t">
        <VersionStatus updates={updates} />
      </Section>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-subtle">
        {title}
      </h3>
      <div className="mt-2 text-[13px] leading-relaxed text-fg-muted">{children}</div>
    </section>
  );
}

function Row({ tone, children }: { tone: "success" | "warning" | "danger" | "neutral" | "accent"; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2">
      <Dot tone={tone} />
      <span className="text-fg">{children}</span>
    </p>
  );
}

function ComfyStatus({ health }: { health: Health | null }) {
  if (!health) return <Row tone="neutral">Checking…</Row>;
  if (health.configured === false) return <Row tone="danger">Not set up: COMFY_URL is missing.</Row>;
  if (!health.reachable) return <Row tone="danger">Can’t reach ComfyUI.</Row>;
  if (health.authorized === false) return <Row tone="danger">ComfyUI refused this app’s token.</Row>;

  const busy = (health.queueRunning ?? 0) > 0;
  const details = [
    health.device,
    health.vramFreeMb && health.vramTotalMb
      ? `${(health.vramFreeMb / 1024).toFixed(1)} of ${(health.vramTotalMb / 1024).toFixed(1)} GB VRAM free`
      : null,
    busy ? "generating now" : null,
    `${health.queuePending ?? 0} queued`,
  ].filter(Boolean);

  return (
    <>
      <Row tone={busy ? "warning" : "success"}>{busy ? "Busy" : "Ready"}</Row>
      <p className="mt-1 pl-4">{details.join(" · ")}</p>
      {health.secure === false ? (
        <p className="mt-1 pl-4 text-warning">
          Connected over plain HTTP, so traffic to ComfyUI is not encrypted.
        </p>
      ) : null}
    </>
  );
}

function MachineStatus({
  compat,
  health,
  workflows,
}: {
  compat: CompatReport | null;
  health: Health | null;
  workflows: WorkflowSummary[];
}) {
  if (!compat) {
    return health?.reachable ? (
      <Row tone="neutral">Checking what it has…</Row>
    ) : (
      <Row tone="neutral">Can’t check until ComfyUI is reachable.</Row>
    );
  }

  const names = new Map(workflows.map((w) => [w.id, w.name]));
  const blocked = workflows.filter((w) => (compat.workflows[w.id]?.blocking.length ?? 0) > 0);
  const partial = workflows.filter(
    (w) => !blocked.includes(w) && (compat.workflows[w.id]?.modes.length ?? 0) > 0,
  );

  if (blocked.length === 0 && partial.length === 0) {
    return (
      <Row tone="success">
        Has everything your workflows need
        {compat.incomplete ? " (some checks timed out; asking again shortly)" : ""}.
      </Row>
    );
  }

  return (
    <>
      <Row tone={blocked.length > 0 ? "warning" : "neutral"}>
        {blocked.length > 0
          ? `Missing what ${blocked.length === 1 ? "one workflow needs" : `${blocked.length} workflows need`}.`
          : "Every workflow runs, but some modes won’t."}
      </Row>
      <ul className="mt-1 flex flex-col gap-1 pl-4">
        {[...blocked, ...partial].map((w) => {
          const status = compat.workflows[w.id];
          const problem = status.blocking[0] ?? status.modes[0]?.problems[0];
          return (
            <li key={w.id}>
              <span className="text-fg">{names.get(w.id)}</span>
              {status.blocking.length === 0 ? ` (${status.modes.map((m) => m.mode).join(", ")})` : ""}
              : missing {problem.name}. {problem.fix}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function VersionStatus({ updates }: { updates: Updates }) {
  const { info, check, checking, checkedAt } = updates;
  const latest = info?.latest;

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <p>
          Version <span className="font-mono text-fg">{info?.current ?? "…"}</span>
        </p>
        <Button size="sm" variant="secondary" onClick={() => void check()} loading={checking}>
          Check for updates
        </Button>
      </div>
      {latest ? (
        <div className="mt-2 rounded-lg border border-border-default bg-bg-subtle p-3">
          <Row tone={latest.machineChanges === false ? "accent" : "warning"}>
            {latest.version} is out.
          </Row>
          <p className="mt-1 pl-4">{updateWhere(latest.machineChanges)}</p>
          <p className="mt-1 pl-4">
            <a href={latest.url} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
              Release notes
            </a>
            {" · "}
            <a href={UPDATING} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
              How to update
            </a>
          </p>
        </div>
      ) : checkedAt ? (
        <p className="mt-2">You’re up to date.</p>
      ) : null}
    </>
  );
}
