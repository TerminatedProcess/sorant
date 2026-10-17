# Setting up Soran’t — a runbook for coding agents

Plain markdown, no tool-specific syntax. Any coding agent can read and follow
this; nothing here depends on a particular assistant.

**If you are a human:** [`setup.md`](setup.md) covers the same ground in a form
meant for reading rather than executing. This file is the version an agent
works from.

## What you are doing

You are running **on the person's ComfyUI machine** — the computer with the GPU
— with this repo cloned onto it. Your job is to configure that machine so the
app works against it: install the custom node packs, download the models,
apply the Windows fixes, lock ComfyUI with a password, run the app here to prove
a generation works, then make ComfyUI reachable and deploy the app to Vercel.
The app itself is the easy part; almost every failed setup is on the ComfyUI
side, which is why you are on it.

**Check that first.** Find ComfyUI on this machine (Phase 0). If it is not here
— the repo was cloned onto a laptop and ComfyUI is elsewhere — stop and say so:
the setup has to run on the ComfyUI machine, so they should clone the repo there
and start you again. The one exception is a ComfyUI that is already fully set up
and reachable; then only Phases 6 and 8 apply, with `COMFY_URL` pointing at it.

Work the phases in order. Phase 5 has to come before Phase 7 in particular: a
ComfyUI made reachable before its password is set can be claimed by whoever
finds it first.

## Ground rules

- **Do the work.** Install, download, edit config, run checks. Do not hand the
  person a list of things you could have done yourself.
- **Ask before** anything that changes the machine beyond ComfyUI's own folder
  (installing system software, the registry), anything that restarts ComfyUI
  while it may be rendering, and anything outward-facing: Tailscale Funnel,
  Vercel projects, environment variables, deploys.
- **Never handle their secrets in chat.** The ComfyUI password, the AI Gateway
  key and the Hugging Face token are typed by the person — into a browser, the
  app, or their own shell. You may read the ComfyUI token from its file and
  write it into `.env.local` or Vercel, but never print it.
- **Tick gates from output, not from what you are told.** Copy this checklist
  into your reply and keep it current:

```
Setup progress:
- [ ] 0 Survey          ComfyUI found; GPU, RAM, disk, Python, version known;
                        workflows chosen; local-only or deploy decided
- [ ] 1 App             gate: `pnpm install` succeeds
- [ ] 2 Node packs      gate: all five import cleanly after a restart
- [ ] 3 Models          gate: `pnpm models:download` exits 0 for the chosen set
- [ ] 4 Windows         TDR raised, --vram-headroom 3 (Windows only)
- [ ] 5 Password        gate: ComfyUI-Login on, password set, token in .env.local
- [ ] 6 Local verify    gate: `pnpm check:nodes` exits 0, gateway key present,
                        one Text to Video run finished
- [ ] 7 Reachability    (deploy only, ask first) gate: public URL refuses
                        without the token and answers with it
- [ ] 8 Deploy          (ask first) gate: deployed pill Ready, one run finished
```

## Phase 0 — Survey the machine

Find out, by looking rather than asking where you can:

- **Where ComfyUI is.** The folder containing `main.py`, `custom_nodes/` and
  `models/`. Common places: a `ComfyUI_windows_portable\ComfyUI` folder, a git
  clone, or the ComfyUI Desktop app's data folder. If several, ask which one
  runs.
- **Which Python runs it.** Packages must go into *that* environment, never the
  system Python. Portable: `python_embeded\python.exe` next to the `ComfyUI`
  folder. A clone: its `venv`/`.venv`. Desktop: the `.venv` in its data folder.
  Read their launch script (`run_nvidia_gpu.bat`, a shell script, a systemd
  unit) to be sure — you will edit it in Phase 4 too.
- **Whether it is running**, and its version: `curl -s
  http://127.0.0.1:8188/system_stats` reports the ComfyUI version, Python,
  PyTorch, OS, RAM and GPU. Not running is fine; a ComfyUI with ComfyUI-Login
  already on answers with a redirect to `/login`.
- **Where models go.** `models/` under ComfyUI, unless an
  `extra_model_paths.yaml` sends them elsewhere — read it if it exists.
- **GPU and drive**: `nvidia-smi`, and free space on the models drive.
- **Node 20+, pnpm and git.** Install pnpm with `npm i -g pnpm` if missing.

**Hardware.** Tested on Windows, ComfyUI 0.38, an RTX 3090 (24 GB) and 64 GB of
RAM. ComfyUI's Dynamic VRAM (NVIDIA, Windows and Linux, not WSL) streams weights
from RAM, so VRAM limits speed and frame size rather than whether a model loads:
16 GB should run the default 0.5 MP frame size; 12 GB has a community report of
864×480, 5 s with Turbo on a 3060. Below 12 GB, AMD or Apple: say it is
unsupported. The full table is in [`setup.md`](setup.md#how-much-vram).

A ComfyUI older than 0.38 should be updated first — the H3, SeedVR2 and FLUX
Kontext nodes are built in, but only on a recent build, and the local director
needs 0.38's `TextGenerate`. Ask before updating a working install.

**Then ask two things:**

1. **Which workflows they want.** Run `pnpm models:download --comfy <ComfyUI
   folder>` after Phase 1 to show what each costs on disk and what is already
   there. Text to Video, Image to Video and Extend share one 43 GB set;
   Reference to Video and Remix add 21 GB, and 118 GB more for a song, voice or
   clip as a reference; Music 14 GB; Upscale 9 GB; the Edit button 29 GB. A
   narrower first pass that works beats a complete one that takes a day.
2. **Local only, or deployed to Vercel.** Local only skips Phases 7 and 8.

## Phase 1 — The app

```bash
pnpm install
```

npm works too if they refuse pnpm — the lockfile is pnpm's, so expect a fresh
resolve and say so.

## Phase 2 — Custom node packs

Clone each into ComfyUI's `custom_nodes/` and install its requirements with
ComfyUI's own Python (`<python> -m pip install -r requirements.txt` — on the
portable build, `python_embeded\python.exe -s -m pip ...`). Skip any already
present; `git pull` updates one.

| Pack | Repository | Needed by |
| --- | --- | --- |
| Vercel AI Gateway | `https://github.com/pwillia7/comfyui-vercel-ai-gateway` | every generating workflow — the five video ones and Music |
| KJNodes | `https://github.com/kijai/ComfyUI-KJNodes` | Remix, Extend, the SageAttention switch |
| VideoHelperSuite | `https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite` | Remix, Extend, a reference clip, Upscale |
| MiniMax-H3 Turbo | `https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo` | the Turbo switch, and any run at 4 steps |
| Spectrum | `https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3` | the Spectrum switch |
| ComfyUI-Login | `https://github.com/liusida/ComfyUI-Login` | locking ComfyUI — **clone it, but read Phase 5 before restarting** |

Treat the first five as required: Turbo, SageAttention and Spectrum all start
switched on, so a video run fails without their packs. A pack that genuinely
will not install can be worked around by turning its switch off in the app's
settings panel — say which.

**SageAttention also needs the `sageattention` Python package** in ComfyUI's
environment; the node patches in a kernel rather than shipping one. Try `<python>
-m pip install sageattention` (on Windows it also needs `triton-windows`), then
check with `<python> -c "import sageattention"`. If it will not install
cleanly against their PyTorch, stop there — do not reinstall PyTorch — and tell
them to switch SageAttention off. `check:nodes` cannot see this package; it only
sees the node.

Restart ComfyUI once all of them, ComfyUI-Login included, are in (ask first if
it may be rendering), and read the startup log: each pack should load without
an import error. The gateway pack logs `[VercelAIGateway] v1.0.0 loaded 5
nodes`. ComfyUI-Login will start locking the server on this restart, so go
straight on to Phase 5's password step if you are doing it now — or leave
ComfyUI-Login out of `custom_nodes/` until Phase 5.

## Phase 3 — Models

```bash
pnpm models:download --comfy <ComfyUI folder>                               # costs and what is present
pnpm models:download --comfy <ComfyUI folder> --workflows minimax-h3,minimax-music3 --dry-run
pnpm models:download --comfy <ComfyUI folder> --workflows minimax-h3,minimax-music3
```

Use `--models-dir <path>` instead of `--comfy` when `extra_model_paths.yaml`
moves them. `--workflows all` takes everything required; `--extras` adds
optional sets (`local-director`, `vhs-tape`, `vhs-tape-lighter`, `upscale-3b`,
`film`); `--skip <file>` leaves one out — the usual one is the bf16 pair,
`minimax_h3_ref2va_bf16.safetensors,qwen3vl_32b_minimax_h3_bf16.safetensors`, if
they will use only pictures as references.

The script works out which files each workflow needs from the graphs
themselves, checks free space before starting, skips files already in place at
the right size, resumes partial downloads, and verifies each file's size. It
exits 0 when everything chosen is in place, so re-run it until it does. These
are tens of gigabytes: run it in the background and carry on with Phase 4.

**The Edit button's FLUX Kontext model is gated.** The person has to accept the
licence at <https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev> while
signed in, create a read token at <https://huggingface.co/settings/tokens>, and
set `HF_TOKEN` in the shell that runs the script. The script stops and says so
if it is missing; `--skip flux1-kontext-dev.safetensors` downloads the rest.

Filenames must match exactly — they are values inside the graphs. If a model is
already on the machine under another name, edit `unet_name` / `clip_name` /
`vae_name` in the workflow file rather than downloading it twice.

**The optional sets, and when to offer them:**

- **`local-director`** — rewrites prompts with an uncensored Gemma through
  ComfyUI's built-in `TextGenerate`, chosen from the app's key button. No key
  and nothing refused, about 20 seconds slower a run. Offer it when refusals are
  what fails their runs. The app finds the file by what it is, not its name.
- **`vhs-tape` / `vhs-tape-lighter`** — the VHS tape content LoRA. H3 LoRAs
  break on the int8 *rotated* base the graphs ship on (warped faces, melting
  limbs, no error), so the switch swaps to a non-rotated checkpoint while on:
  bf16 (66 GB) or the fp8 **Lighter base** (21 GB). One of the two, not both.
  Reference to Video and Remix use the `ref2va` bf16 file for it.
- **`upscale-3b`**, **`film`** — Upscale's lighter model and its slower FILM
  interpolation, picked in its controls.

Music 3 also has an `int8_convrot` DiT for short-VRAM cards; using it means
changing `unet_name` in `minimax-music3.ts`.

## Phase 4 — Windows only

**Raise the GPU timeout before the first H3 run.** H3 issues single GPU
operations long enough to cross Windows' two-second TDR limit. When the driver
reset succeeds, ComfyUI dies and Display event 4101 is logged; when it fails,
the machine blue-screens and restarts with nothing in the log. On a 3090 it was
about a third of runs. These need an elevated prompt and a reboot — ask first,
run them if you are elevated, otherwise give them the two lines to paste into an
Administrator terminal:

```
reg add "HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers" /v TdrDelay /t REG_DWORD /d 60 /f
reg add "HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers" /v TdrDdiDelay /t REG_DWORD /d 60 /f
```

The reboot can wait until the downloads finish.

**Add `--vram-headroom 3` to ComfyUI's launch line** (the `.bat` or script you
found in Phase 0). It keeps Dynamic VRAM from paging into a full card, a
separate Windows failure (Comfy-Org/ComfyUI#15360), at no cost in speed.

## Phase 5 — Lock ComfyUI with a password

Do this even for local-only use if the machine is on a shared network, and
always before Phase 7.

**There is no default password.** ComfyUI-Login has none until someone sets
one, and whoever first opens its login page chooses it. Until then it is not a
lock at all: the token it checks against is empty, so a request carrying an
empty `?token=` is let through. Set the password in the same sitting as the
restart that enables it, and always before ComfyUI is reachable from the
internet.

1. With ComfyUI-Login in `custom_nodes/`, restart ComfyUI.
2. Have the person open <http://127.0.0.1:8188> in a browser **on this
   machine**. The first visit shows a first-time page: they choose a username
   and password. That password is what they will type to use ComfyUI's own web
   interface from now on. Do not choose it for them.
3. The API token is the bcrypt hash of that password, stored as the **first
   line of `<ComfyUI folder>/login/PASSWORD`** (the console also prints it as
   `For direct API calls, use token=$2b$...`). Read it from the file and write
   it into `.env.local` (Phase 6) — without printing it.

**Forgotten password, or a fresh start:** stop ComfyUI, delete
`login/PASSWORD`, restart, and set a new one. The token changes with it, so
update `.env.local` and Vercel.

## Phase 6 — Configure and verify locally

```bash
cp .env.example .env.local
```

- `COMFY_URL=http://127.0.0.1:8188` (or the port their launch line sets).
- `COMFY_API_TOKEN=` the token from Phase 5, with **every `$` escaped as `\$`**
  — dotenv reads `$2b` as a variable and silently blanks it:
  `COMFY_API_TOKEN=\$2b\$12\$AbCd...`
- `APP_ACCESS_TOKEN=` a new random value (`openssl rand -hex 32`, or
  `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`). This is
  **the app's password** — what they type at the deployed app's gate. Tell them
  to keep it in a password manager, and where it is. Optional for local use,
  required before deploying.

Then:

```bash
pnpm check:nodes
```

It asks ComfyUI for every node class, model file and dropdown option the
workflows use, names the pack behind each missing class, and reports whether the
gateway pack can see a key. Exit **0**: everything required is there. **1**:
something is missing — fix it from its output, mapping classes to packs in
Phase 2. **2**: it could not ask at all — ComfyUI not running, wrong
`COMFY_URL`, or the token rejected (check the `\$` escaping first). Optional
files reported absent do not fail it.

**The gateway key.** Every generating workflow rewrites the prompt through a
language model on the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway),
called by the gateway pack on this machine. `check:nodes` will report no key
until there is one. The person creates it at
[vercel.com/dashboard](https://vercel.com/dashboard) → **AI Gateway** → **API
Keys** ($5 of free credit a month) and enters it themselves, one of two ways:

- **The key button in the app's header**, once `pnpm dev` is running. It writes
  `custom_nodes/comfyui-vercel-ai-gateway/config.json` on this machine and is
  never stored by the app.
- **`AI_GATEWAY_API_KEY` in ComfyUI's launch environment** — you can add the
  line to the launch script with a placeholder for them to fill in. It wins over
  the file.

Without a key at all, the **Send my prompt as written** switch beside each
prompt runs without the rewrite — mention it, but not as the normal way to run:
the rewrite is most of what makes a one-line prompt work. The local director
(Phase 3 extras) is the key-free alternative.

Now run the app:

```bash
pnpm check:workflows   # the app's own definitions; needs no ComfyUI
pnpm dev
curl -s localhost:3000/api/health -H "x-app-token: <APP_ACCESS_TOKEN>"
# want: "reachable":true,"authorized":true
```

Have the person open <http://localhost:3000>, confirm the pill reads **Ready**,
and run one **Text to Video** generation — it needs no upload, and it proves the
models load and the key works, which no check can. Then one of each other
workflow they chose, if they have the time.

## Phase 7 — Reachability (deploying only)

A Vercel function is not on their network, so ComfyUI must be reachable from
the internet. Ask before doing any of this.

### Tailscale Funnel — recommended

Real HTTPS, no open router ports, survives a changing home IP. On this machine:

1. Install Tailscale if it is not (`tailscale version`); the person signs in.
2. The person, in the Tailscale admin console: **DNS** → enable **MagicDNS** and
   **HTTPS Certificates**; **Access Controls** → add
   `"nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]`.
3. You: `tailscale funnel --bg --https=443 localhost:8188` (ComfyUI's *local*
   port), then `tailscale funnel status` for the public URL —
   `https://<machine>.<tailnet>.ts.net`. That is the deployed `COMFY_URL`.

Funnel is public, not tailnet-private — that is the point, since Vercel is not
on their tailnet — so the ComfyUI-Login token is what guards it. Tailscale
*Serve* is the private variant and will not work.

### Dynamic DNS and a port forward

If Tailscale is unwelcome: a DDNS hostname (DuckDNS, No-IP, Afraid.org, or the
router's own) plus a router port forward to 8188; `COMFY_URL` is
`http://<host>:<port>`. The person does the router side. Say plainly that a
forwarded port is not encryption — the token and prompts cross the internet in
cleartext, so it should be rotated if it ever has — and that ComfyUI is now on
the open internet. A static public IP works the same way, only if the ISP
guarantees it.

**Gate:** from outside, the public URL must refuse without the token and answer
with it:

```bash
curl -s -o /dev/null -w "%{http_code}\n" <public URL>/system_stats                          # 302 or 401
curl -s -o /dev/null -w "%{http_code}\n" <public URL>/system_stats -H "Authorization: Bearer <token>"  # 200
```

## Phase 8 — Deploy to Vercel

Only once a local generation has succeeded. Ask before each outward step.

```bash
pnpm i -g vercel     # if needed
vercel login         # the person signs in, in their browser
vercel link
```

Environment variables, Production scope. **Values here are literal — no `$`
escaping.** `vercel env add` reads the value from stdin; pipe it in rather than
pasting it into chat, and never pass `NAME=value` as an argument:

```bash
vercel env add COMFY_URL production          # the PUBLIC url from Phase 7, never localhost
vercel env add COMFY_API_TOKEN production    # the unescaped token
vercel env add APP_ACCESS_TOKEN production
```

**A private Blob store, for uploads over 4 MB.** Vercel refuses request bodies
over 4.5 MB, so larger uploads go from the browser to Blob and are copied to
ComfyUI from there. Without one, small uploads work and large ones fail.

```bash
vercel blob create-store sorant-uploads --access private --yes
vercel deploy --prod
```

`create-store` adds `BLOB_READ_WRITE_TOKEN` to every environment and also
rewrites `.env.local` with the project's Development variables — check that
`COMFY_URL` and `COMFY_API_TOKEN` there are still right afterwards. The upload
ceiling is 100 MB, matching ComfyUI's `--max-upload-size 100`; raise
`LARGE_UPLOAD_MAX_BYTES` in `src/lib/upload-limits.ts` together with that flag.

Then the person loads the deployment, enters `APP_ACCESS_TOKEN` at the gate,
confirms **Ready**, and generates once.

**If they connect the GitHub repo instead:** a push to `main` deploys
production, other branches get previews. Production on Hobby and Pro is
publicly reachable, so `APP_ACCESS_TOKEN` is the only gate. If the fork is
public, leave **Git Fork Protection** on (Project Settings → Security) — it
stops a stranger's pull request from building with their environment
variables, ComfyUI token included.

## When something is wrong

| Symptom | Look at |
| --- | --- |
| Pill reads **Offline** | `COMFY_URL`; ComfyUI running; port reachable from where the app runs |
| Pill reads **Auth failed** | `COMFY_API_TOKEN`; the `$` escaping; whether the password was reset since |
| Works locally, fails deployed | `COMFY_URL` still `localhost`, or `$` escaped in Vercel where it should not be |
| Valid token still rejected | ComfyUI launched with `--enable-cors-header <specific-origin>`: ComfyUI-Login only checks the bearer token when that matches, and server-side calls send no Origin. Drop the flag or set it to `*` |
| Every API call gets 401 or a redirect to `/login` | No password set yet, or no token sent — Phase 5 |
| A pack fails to import at startup | Its requirements were installed into the wrong Python. Reinstall with ComfyUI's own |
| Fails with SageAttention on, works with it off | The `sageattention` package — Phase 2 |
| A run fails naming a node class | `pnpm check:nodes` — a pack is missing |
| Only the **Edit** button fails | One of the FLUX Kontext files; `models:download --workflows image-edit` |
| Fails at the rewrite, no key | The gateway key — Phase 6 |
| Fails at the rewrite, no reason | Usually a refusal. Change **Rewrite model** and retry |
| Rewrite refused: model not in the list | The gateway retired it. `pnpm sync:models`, then commit the regenerated file |
| "The local director is chosen but … is not in" | `models:download --extras local-director`, or switch back to the gateway |
| Large uploads fail deployed, work locally | No Blob store — Phase 8 |
| A job shows as **Lost** | ComfyUI restarted and dropped its history |
| "Contact was lost" | The connection dropped, not the workflow. Check the pill and resubmit |
| The Windows machine restarts during step 1 | The TDR values — Phase 4. Display event 4101 in the System log confirms it |

`/api/health` reports `reachable`, `authorized` and `secure` separately, so it
tells "cannot connect" from "connected but refused".

## Done when

- `pnpm check:nodes` exits 0 against the `COMFY_URL` the app uses.
- One generation has finished locally, and — if deploying — one on the
  deployment.
- ComfyUI-Login is on, and the public URL refuses a request without the token.
- The deployment asks for `APP_ACCESS_TOKEN` before anything else.

Then tell the person, in a short list: their two passwords and what each is for
(the ComfyUI password for ComfyUI's own web page; `APP_ACCESS_TOKEN` for the
app), where each is kept, what they skipped (workflows not downloaded, optional
sets, switches to keep off because a pack would not install), and whether the
Windows reboot is still pending.
