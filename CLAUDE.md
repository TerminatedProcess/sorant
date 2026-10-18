# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
pnpm dev                    # dev server (localhost:3000)
pnpm build                  # runs sync:models first (prebuild), then next build
pnpm typecheck              # tsc --noEmit — the gate before calling anything done
pnpm check:workflows        # offline: param targets, declarations, finalizeCases, requirements staleness
pnpm requirements:write     # regenerate machine-requirements.json after touching src/lib/workflows/
pnpm check:nodes            # needs COMFY_URL: asks a live ComfyUI what's installed
pnpm smoke                  # one real end-to-end generation through the running app
pnpm smoke --workflow minimax-music3 --director local|none --url https://<app>.vercel.app
```

There is no test runner and no lint script. `check:workflows` is the closest
thing to a unit suite; `smoke` is the end-to-end proof (exit 0 = a file was produced).

## Architecture

```
browser ──HTTPS──> Next.js route handlers (src/app/api/*) ──HTTP──> ComfyUI (COMFY_URL)
```

- **Everything goes through the proxy.** The deployed page is HTTPS and ComfyUI
  is plain HTTP, so the browser can't call it directly; the proxy also keeps
  `COMFY_URL` and the auth token out of the bundle. `/api/media` streams video
  with `Range` forwarded so seeking works.
- **Submit-then-poll, no server state.** `/api/generate` returns once ComfyUI
  accepts the job; the client (`src/hooks/use-jobs.ts`) polls `/api/status`.
  ComfyUI owns the queue and history — don't add server-side job storage.
- **Workflow registry:** `src/lib/workflows/index.ts` `WORKFLOWS` is the whole
  set. A new workflow is a new file beside `minimax-h3.ts` plus one entry there.
  Turbo is not a separate workflow — the LoRA is spliced in at queue time
  (`turbo.ts`). `archive/` holds retired graphs; `generated/` is written by scripts.
- **Machine compatibility:** `machine-requirements.json`'s `fingerprint` is
  compared against the live machine (`src/lib/compat.ts`, served by `/api/compat`) and against
  the latest GitHub release (`/api/updates`) to decide app-only vs. needs-machine updates.
- Deep dives: `docs/development.md` (adding a workflow, queueing, ComfyUI-Login
  auth failures, releasing), `docs/workflows.md`, `docs/prompt-rewrite.md`, `docs/modes.md`.

## Releasing

1. Bump `version` in `package.json` (tag is `v<version>`).
2. `pnpm requirements:write && pnpm check:workflows && pnpm typecheck`.
3. Commit, push, `git tag vX.Y.Z && git push origin vX.Y.Z`, `gh release create`.
4. Release notes must end with a **"ComfyUI machine changes"** section, derived
   by diffing `machine-requirements.json` against the previous tag — not from memory.
   Same fingerprint → "None. This update is app-only."

## Agent files

`.claude/skills/{setup,update}` and `.agents/skills/` are thin pointers to
`docs/agent-setup.md`. Fix the runbook, not the skills.
