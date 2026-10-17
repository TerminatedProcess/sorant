---
name: setup
description: Sets up Soran't against the user's own ComfyUI install and deploys it to Vercel. Use when someone has cloned this repo and wants to get it running, connect it to their ComfyUI, find which custom nodes or model files are missing, make ComfyUI reachable from the internet, fix a connection that reports Offline or Auth failed, fix uploads failing once deployed, or ship it to production.
---

# Setting up Soran’t

Read [`docs/agent-setup.md`](../../../docs/agent-setup.md) from the repository
root, all of it, and follow it.

That runbook is the single source of truth and is deliberately tool-neutral, so
this repo stays usable from any coding agent rather than just one. This file
exists only because skill discovery paths differ per agent — it is a pointer,
not a copy. If something here needs correcting, correct the runbook.

What it asks of you, worth carrying in before you start:

- **Copy its progress checklist into your reply** and tick each gate from a
  command's output, not from what the person says happened.
- **The ComfyUI box is usually not your machine.** Hand the person exact steps
  for it, then verify from here with `pnpm check:nodes` — exit 0 is done, 1 is
  something missing, 2 means it could not ask (URL or token, not models).
- **Work the phases in order.** Phase 3 fails confusingly when phase 2 was not
  really finished, and the point is that the person finds out now rather than
  six minutes into a generation.
- **Ask before anything outward-facing** — creating Vercel projects, adding
  environment variables, creating a Blob store, deploying. Local checks need no
  permission.
