# Setting up Soran’t — a runbook for coding agents

Plain markdown, no tool-specific syntax. Any coding agent can read and follow
this; nothing here depends on a particular assistant.

**If you are a human:** [`setup.md`](setup.md) covers the same ground in a form
meant for reading rather than executing. This file is the version an agent
works from.

You are walking someone through connecting this app to *their* ComfyUI and
getting it deployed. Assume they have a working ComfyUI and nothing else.

Work through the phases in order. Do not skip ahead — phase 3 fails in
confusing ways if phase 2 was not really finished, and the whole point of this
runbook is that they find out early instead of six minutes into a generation.

Ask before doing anything outward-facing: creating Vercel projects, adding
environment variables, deploying. Run local checks freely.

## Before you start: who can do what

You are almost certainly running beside the repo, and ComfyUI is almost
certainly on a different machine — often a Windows box with the GPU. You cannot
install node packs, download models, edit its registry or restart it. So for
those phases your job is to hand the person an exact list for *their* machine,
wait, and then verify from here: `pnpm check:nodes` asks the box itself, which
is better evidence than anything they report back. If ComfyUI *is* on this
machine, ask before installing into it — it is their environment, not the
repo's.

Copy this into your reply and keep it current as you go. Do not tick a gate
from what the person tells you; tick it from the command's output.

```
Setup progress:
- [ ] 0 Toolchain       gate: `pnpm install` succeeds
- [ ] 1 ComfyUI         (person, on the box) packs, models, gateway key, Windows TDR
- [ ] 2 Reachability    decided: local only / Funnel / DDNS
- [ ] 3 Auth            ComfyUI-Login on if reachable from the internet
- [ ] 4 Local verify    gate: `pnpm check:nodes` exits 0, pill reads Ready,
                        one Text to Video run finished
- [ ] 5 Deploy          (ask first) env vars, Blob store, deploy
                        gate: deployed pill Ready, one run finished
```

`pnpm check:nodes` exits **0** when everything required is there, **1** when
something is missing (it prints what, and which pack), and **2** when it could
not ask at all — no `COMFY_URL`, unreachable, or token rejected. Treat 2 as a
phase 2–3 problem, never as "nothing is installed". Optional files reported as
absent do not fail it and do not block the person.

**Check the machine can carry it before anything else.** Tested on Windows,
ComfyUI 0.38, an RTX 3090 (24 GB) and 64 GB of RAM. Smaller cards are expected
to work rather than shown to: ComfyUI's Dynamic VRAM (NVIDIA, Windows/Linux, not
WSL) streams weights from RAM, so VRAM limits speed and frame size rather than
whether a model loads. 16 GB should run the default 0.5 MP frame size; 12 GB has
a community report of 864×480, 5 s with Turbo on a 3060. Below 12 GB, or on AMD
or Apple, say it is unsupported. With less VRAM, 64 GB of RAM matters more —
ask what they have. The full table is in [`setup.md`](setup.md#how-much-vram);
point them there rather than restating it. Disk, by what they want to run:

| Wants | Adds |
| --- | --- |
| Text to Video, Image to Video, Extend | 43 GB — the floor |
| Reference to Video and Remix | +21 GB |
| …with a soundtrack, voice or clip as a reference, or Remix at 4 steps | +118 GB (the bf16 pair) |
| Music | +14 GB |
| Upscale | +9 GB |
| The Edit button | +29 GB |
| Everything required | about 234 GB |
| Local director, VHS tape, the lighter Upscale / FILM models | optional, up to +100 GB more |

Ask which workflows they actually want before sending them off to download.
Twenty-one model files is the whole app; Text to Video alone is five (see the
table in Phase 1). A narrower first pass that works beats a complete one that
takes a day.

## Phase 0 — Is the toolchain there

```bash
node --version   # 20+
pnpm --version   # if missing: npm i -g pnpm
```

Then `pnpm install`.

If they do not have pnpm and would rather not install it, npm works — the
lockfile is pnpm's, so expect a fresh resolve and say so rather than letting it
look broken.

## Phase 1 — What ComfyUI needs

The app is the easy half. Almost every failed setup is here.

Tell them plainly what has to be true, then let them go do it:

**Custom nodes** — five packs. Four install from ComfyUI Manager by name; the
first one installs by Git URL:

- **Vercel AI Gateway** (`pwillia7/comfyui-vercel-ai-gateway`) — provides
  `VercelAIGatewayGenerateText` and `VercelAIGatewayDescribeImage`. Not in the
  Manager's registry by name: **Install via Git URL**, with
  `https://github.com/pwillia7/comfyui-vercel-ai-gateway`, then
  `pip install -r requirements.txt` in ComfyUI's own environment if the Manager
  does not. **Every generating workflow needs this** — all five video ones and
  Music. Each rewrites the user's prompt through a language model before the
  model sees it, so without these nodes nothing generates at all. (Upscale and
  Edit image have no prompt to rewrite and do not use it.) The log line to look
  for after a restart is `[VercelAIGateway] v1.0.0 loaded 5 nodes`.
- **ComfyUI-KJNodes** (`kijai/ComfyUI-KJNodes`) — provides
  `GetImageSizeAndCount`, `RandomImageFromBatch`, `AudioConcatenate` and
  `PathchSageAttentionKJ` (the misspelling is the pack's). Remix needs the
  first, Extend the next two; every video workflow needs the last one, but only
  with the **SageAttention** switch on. That switch also needs the `sageattention` Python
  package installed in ComfyUI's own environment, because the node patches in a
  kernel rather than shipping one — this is the one requirement here that
  `check:nodes` cannot see, so a run failing with the switch on against a node
  the checker calls present means the package is what is missing.
- **MiniMax-H3 Turbo** (`Larryvrh/ComfyUI-MiniMax-H3-Turbo`) — provides
  `MiniMaxH3TurboLoRA` and `MiniMaxH3TurboSampler`. The **Turbo** switch needs
  the first, and also wants the LoRA file listed below; every video workflow
  offers that switch. The second is used by every workflow whenever the steps control is on
  4, switch or no switch — that step count is what the sampler is for, so the
  graph swaps it in rather than asking. So this pack is needed with the switch
  off too, if anyone sets steps to 4.
- **ComfyUI-VideoHelperSuite** (`Kosinkadink/ComfyUI-VideoHelperSuite`) —
  provides `VHS_LoadVideo`, `VHS_SelectEveryNthImage`, `VHS_BatchManager`,
  `VHS_VideoInfoLoaded` and `VHS_VideoCombine`. Everything that reads a clip:
  Remix, Extend, a reference clip on Reference to Video, and Upscale.
- **Spectrum** (`ComfyUI-Spectrum-MiniMax-H3`) — provides
  `SpectrumApplyMiniMaxH3`. Only the **Spectrum** switch needs it, and unlike
  turbo it needs no model file; every video workflow offers it. This repo took
  the node from a ComfyUI export rather than pinning a repo, so search the
  Manager by that name or by the class name; `pnpm check:nodes` reports the
  owning package once it is installed.

**Treat all five as required.** Turbo, SageAttention and Spectrum all start
switched on, so a fresh install needs the gateway, KJNodes, turbo and Spectrum
packs before the first video generation succeeds — a user who has not
installed one will see every run fail rather than only the runs that opted in. They can be turned off per workflow in
the settings panel if a pack is genuinely unavailable.

The remaining node classes are ComfyUI built-ins — including the four
`MiniMaxH3*` sampling nodes and `ComfyMathExpression`. If those come back
missing, their ComfyUI is too old; updating is the fix, not hunting for packs.

A pack that only part of the app needs is worth saying out loud, because the
failure is confusing: everything else generates fine and the runs that need it
die several minutes in, on a class nobody recognises. For everything behind a
switch the tell is that the same workflow succeeds with it off and fails with it
on. `pnpm check:nodes` names both the class and the pack that owns it — and it
checks the turbo and patched forms of each graph as well as the stored one — so
run it rather than guessing.

**A gateway key on the ComfyUI host.** Do not skip this. It is the most likely
reason a setup that looks correct fails partway through its first generation.

The app never holds the key — it stays on the ComfyUI host rather than crossing
the network from Vercel, and it is deliberately never written into a graph,
because ComfyUI copies the queued prompt into the metadata of every file a
workflow saves.

The key comes from [vercel.com/dashboard](https://vercel.com/dashboard) → **AI
Gateway** → **API Keys**. Every team gets $5 of credit a month, and the picker
marks the models that cost nothing against it — one, as of this writing.

There are two ways to land it on the machine, and either is enough:

1. **`AI_GATEWAY_API_KEY` in the environment ComfyUI actually launches in.** Not
   a different terminal, not their shell profile if ComfyUI runs as a service.
   Same shell as `python main.py` (`export` on macOS/Linux, `$env:AI_GATEWAY_API_KEY = "..."`
   in PowerShell), or `Environment=` in the systemd unit. This wins over the
   file below.

2. **From the app**, once it is running: the key button in the header, which
   wears a warning colour until a key is set. It posts to the pack's own config
   route and lands in `custom_nodes/comfyui-vercel-ai-gateway/config.json`,
   which is gitignored. Prefer this when ComfyUI is on a machine they are not
   sitting at — which is most of the time.

Either way, `pnpm check:nodes` reports whether the pack can see a key, so this
is checkable before a render rather than after one.

**Not using a language model at all?** Every workflow has a **Send my prompt as
written** switch beside its prompt box, which queues a graph with no rewrite
node in it — no key needed for that run. Say so if they have no key to hand, but
do not offer it as the way to run the app: the rewrite is most of what makes a
one-line prompt produce a usable video, and the switch is for someone writing
MiniMax's own format by hand.

**Which model does the rewriting is a control, not a constant.** **Rewrite
model** under the prompt box offers a couple of dozen — roughly the newest
seeing and newest text-only model per provider family — labelled with what they
cost and which are free, built from the gateway's live catalog by `pnpm sync:models`. If a job
dies at the rewrite step with an error that says nothing useful, that is usually
a refusal — have them pick a different model rather than debug the prompt. The
curation is in `src/lib/workflows/rewrite-catalog.ts`.

**Or the rewrite can run on their own GPU, with nothing refused.** The key
button in the header also chooses *where* the prompt is rewritten: the gateway,
or **this ComfyUI machine**, which runs an uncensored model through ComfyUI's
built-in `TextGenerate` node — no key, no content policy, and it can see the
pictures the image workflows show their director. It costs about twenty seconds
per run, and it needs two things the gateway does not: a ComfyUI recent
enough that `TextGenerate` takes a `system_prompt` input (0.38 does; 0.33 does
not), and one more file in `models/text_encoders/` — `gemma4_12b_uncensored_heretic_int8_convrot.safetensors` from
<https://huggingface.co/radiatingreverberations/Gemma-4-12B-It-Uncensored-Heretic-INT8-ConvRot-ComfyUI>,
12 GB. Not an LTX-2.5 text-encoder build of the same model (DeepNeuralNerd's,
say): it works, but writes each brief about four times slower, and the app
only uses one when nothing else is installed. Whatever the
download saved it as is fine; the app finds it by what it is. Offer this when
refusals are what is failing their runs, not as part of the default setup.
`pnpm check:nodes` reports it under **Local director (optional)**.

**Twenty-one model files.** Eighteen are needed by something a fresh install
runs. The other three belong to the content-LoRA switch, which is off by
default — all three are optional, and none is needed unless they want that look.
Nobody needs all of them on day one: Text to Video alone runs on five — the
`fl2va` int8 base, the nvfp4 Qwen encoder, the two H3 VAEs and the turbo LoRA.

| File | Directory | Needed by |
| --- | --- | --- |
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` | all but the reference and music workflows |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` | the reference workflows |
| `minimax_h3_ref2va_bf16.safetensors` | `models/diffusion_models/` | Reference to Video with a soundtrack, voice or clip reference attached (any step count); Remix at 4 steps. 66 GB |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `models/text_encoders/` | the five video workflows |
| `qwen3vl_32b_minimax_h3_bf16.safetensors` | `models/text_encoders/` | the same runs, alongside the bf16 diffusion model. 52 GB |
| `minimax_h3_video_vae_fp16.safetensors` | `models/vae/` | the five video workflows |
| `minimax_h3_audio_vae_fp32.safetensors` | `models/vae/` | the five video workflows |
| `minimax_h3_turbo_v4_step600_ema.safetensors` | `models/loras/` | the Turbo switch only (every video workflow) |
| `vh5tape-comfyui.safetensors` | `models/loras/` | optional — the **VHS tape** content LoRA (all five video workflows) |
| `minimax_h3_fl2va_bf16.safetensors` | `models/diffusion_models/` | optional — what **VHS tape** runs on for the `fl2va` graphs, replacing the rotated base above while the switch is on |
| `minimax_h3_fl2va_pruned_fp8_scaled.safetensors` | `models/diffusion_models/` | optional — **VHS tape** on **Lighter base**, instead of bf16 |
| `minimax_music3_dit_fp16.safetensors` | `models/diffusion_models/` | Music |
| `minimax_music3_text_encoder_pruned_int8_convrot.safetensors` | `models/text_encoders/` | Music |
| `minimax_music3_dav.safetensors` | `models/vae/` | Music |
| `seedvr2_7b_sharp_int8_convrot.safetensors` | `models/diffusion_models/` | Upscale |
| `seedvr2_ema_vae_fp16.safetensors` | `models/vae/` | Upscale |
| `rife_v4.26.safetensors` | `models/frame_interpolation/` | Upscale's **Frame rate: Double it** |
| `flux1-kontext-dev.safetensors` | `models/diffusion_models/` | Edit image (the **Edit** button on a picture) |
| `clip_l.safetensors` | `models/text_encoders/` | Edit image |
| `t5xxl_fp8_e4m3fn.safetensors` | `models/text_encoders/` | Edit image |
| `ae.safetensors` | `models/vae/` | Edit image |

Sources: <https://docs.comfy.org/tutorials/video/minimax/minimax-h3> for the H3
files and <https://huggingface.co/Comfy-Org/MiniMax-Music-3> for the Music 3
ones, and <https://huggingface.co/Comfy-Org/SeedVR2> for Upscale's — which can
also run on `seedvr2_3b_int8_convrot` from the same place, picked in its Model
control; that one is optional. Upscale is ComfyUI built-ins for the model and
VideoHelperSuite for the video either side of it — its loader, Meta Batch
Manager and Video Combine, which run a clip through in batches so a long one
does not run the machine out of RAM. Its frame interpolation loads from
<https://huggingface.co/Comfy-Org/frame_interpolation>: `rife_v4.26` as above,
and optionally `film_net_fp16` for the FILM choice under Advanced. The turbo
LoRA is not from any of these: it is
<https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora>. Neither the
SageAttention nor the Spectrum switch adds a model file of its own.

**Edit image is FLUX.1 Kontext dev, on core nodes only** — ComfyUI's
[Kontext tutorial](https://docs.comfy.org/tutorials/flux/flux-1-kontext-dev)
lists the same four files. It is not in the
workflow picker — it is what the **Edit** button on any image control runs, so
it is easy to forget until someone presses it. The diffusion model is
`black-forest-labs/FLUX.1-Kontext-dev` on Hugging Face, which is gated: they
accept the licence there before the download works. The two text encoders are
in `comfyanonymous/flux_text_encoders`, and `ae.safetensors` is the FLUX VAE
(in `Comfy-Org/Lumina_Image_2.0_Repackaged` under `split_files/vae/`, ungated,
or the gated BFL repo). The file is bf16 and the graph casts it to fp8 on load,
which is what fits it beside T5 on a 24 GB card. It is optional in the sense
that nothing else needs it — skip it and only the Edit button fails.

**The content-LoRA switch brings its own files, and the checkpoint is the one to
explain.** MiniMax-H3 LoRAs are made for fp16/fp8 bases. The `fl2va` graphs ship
on `minimax_h3_fl2va_pruned_int8_convrot`, which is what the official ComfyUI H3
tutorial defaults to and is a *rotated* base: a LoRA loads into it without any
error and then produces warped faces, melting limbs and vanishing objects. So the
switch swaps the loader to a checkpoint the chosen LoRA supports while it is on —
for **VHS tape**, `minimax_h3_fl2va_bf16` on the `fl2va` graphs and
`minimax_h3_ref2va_bf16` on Reference to Video and Remix. The `ref2va` one is
already needed by those graphs at 4 steps, so it adds no download.

That file is large, and none of this is needed by anyone who does not want the
look: the switch starts **off**, so an install without these files fails nothing
until someone turns it on. `pnpm check:nodes` therefore reports every LoRA in the
list and every checkpoint it can run on as **optional** rather than missing.

**If the default checkpoint will not fit on their card, or they do not want the
download**, each LoRA can offer a **Lighter base** toggle. For VHS tape that runs
`minimax_h3_fl2va_pruned_fp8_scaled` instead — smaller and much easier on VRAM,
for some quality. Both are non-rotated, so either is safe for the LoRA; they need
one of the two, not both.

**Upscale needs VideoHelperSuite and nothing else custom**; its SeedVR2 and
frame-interpolation nodes are built into a recent ComfyUI.

**Music needs no node pack but the gateway one.** Every other class in that graph
is a ComfyUI built-in, so if they only want music, the three files above plus a
recent ComfyUI is the whole of Phase 1 for them.

For a card short on VRAM, Music 3 also comes as an `int8_convrot` DiT; using it
means changing `unet_name` in `minimax-music3.ts`.

The filenames must match, because they are values inside the graph rather than
choices in the UI. If theirs are named differently, the better fix is editing
the `unet_name` / `clip_name` / `vae_name` in the relevant workflow file — one
line, and it survives re-downloading models.

**On Windows, raise the GPU timeout before the first H3 run.** H3 issues
single GPU operations long enough to cross Windows' two-second TDR limit, most
often as step 1 begins. When the driver reset that follows succeeds, Windows
logs Display event 4101 and ComfyUI dies; when it fails, the machine
blue-screens and restarts in about 25 seconds with nothing in the log — which
reads as "the whole PC crashes" or "the remote session logs out". On a 3090 it
happened on roughly a third of runs, at any size and with turbo merged or not.
In an Administrator prompt, then reboot:

```
reg add "HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers" /v TdrDelay /t REG_DWORD /d 60 /f
reg add "HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers" /v TdrDdiDelay /t REG_DWORD /d 60 /f
```

Eight runs in a row then passed that had been crashing. Also add
`--vram-headroom 3` to the launch line: it keeps dynamic VRAM from paging into
a full card, a separate Windows failure (Comfy-Org/ComfyUI#15360), at no
measurable cost in speed.

Have them restart ComfyUI after installing nodes.

## Phase 2 — Reachability, and the decision that trips people up

**Ask what they are doing, because the answer changes everything:**

**Running locally only** (`pnpm dev` on the same machine or LAN):
`http://localhost:8188` is fine. Skip to phase 3. Nothing else is needed.

**Deploying to Vercel:** ComfyUI must be reachable *from Vercel's servers*.
A Vercel function is not on their network, so `localhost` and `192.168.x.x`
cannot work. This surprises people — be explicit about it.

Three ways, best first:

### Tailscale Funnel — recommended

Gives real TLS, needs no open inbound ports, and survives a changing home IP.
Terminates TLS on their own machine, so Tailscale relays without decrypting.

On the ComfyUI host:

1. Install Tailscale, sign in.
2. Admin console → DNS → enable **MagicDNS** and **HTTPS Certificates** (Funnel
   issues no certificate without both).
3. Admin console → Access Controls → grant the funnel attribute:
   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```
4. Point it at ComfyUI's **local** port:
   ```
   tailscale funnel --bg --https=443 localhost:8188
   ```
5. `tailscale funnel status` gives the public hostname —
   `https://their-box.their-tailnet.ts.net`. That is `COMFY_URL`.

Warn them: Funnel is *public*, not tailnet-private. That is the point, since
Vercel cannot reach a tailnet — but it means `COMFY_API_TOKEN` is the only thing
guarding it. Tailscale *Serve* is the private variant and will not work here.

### Dynamic DNS + port forward

Works, and is what to reach for if Tailscale is unwelcome. Home IPs usually
rotate, so a bare IP goes stale; DDNS keeps a hostname pointed at it.

1. Pick a provider — No-IP, DuckDNS, Afraid.org, or whatever their router has
   built in (many have No-IP or DynDNS under WAN/DDNS settings).
2. Register a hostname and set up the updater — router-side if it offers it,
   otherwise the provider's client on the ComfyUI host.
3. Forward an external port to the ComfyUI machine's port 8188.
4. `COMFY_URL` is `http://their-host.ddns.net:<external-port>`.

Two things to say plainly:

- **A forwarded port is not TLS.** Forwarding 8443 to ComfyUI does not encrypt
  anything — the number means nothing on its own. The app works fine over plain
  HTTP because all ComfyUI traffic is server-side, but the bearer token and
  every prompt cross the internet in cleartext. Treat the token as compromised
  if it has ever gone over plain HTTP.
- This exposes ComfyUI to the whole internet. `COMFY_API_TOKEN` via
  ComfyUI-Login (phase 3) is not optional here.

### Raw public IP

Only if their ISP gives them a static IP. Same port forward, `COMFY_URL` is
`http://<ip>:<port>`. It breaks the day the IP changes, which is why DDNS
exists. Do not recommend this unless they say the IP is static.

## Phase 3 — Authentication

If ComfyUI is reachable from the internet at all, it needs
[ComfyUI-Login](https://github.com/liusida/ComfyUI-Login). Without it, anyone
who finds the URL can queue jobs on their GPU.

Install it, set a password, and take the bcrypt hash it prints to the console —
that hash *is* `COMFY_API_TOKEN`, not the password.

**The trap that catches most people:** the hash starts with `$2b$`, and dotenv
treats `$2b` as a variable reference, so pasting it raw into `.env.local`
silently blanks it. Every `$` must be escaped:

```bash
# console prints:  $2b$12$AbCdEf...
COMFY_API_TOKEN=\$2b\$12\$AbCdEf...
```

**Values set in the Vercel dashboard or via `vercel env add` are literal — do
NOT escape them there.** Getting this backwards is the most common cause of
"works locally, 401s in production" and vice versa.

## Phase 4 — Configure and verify locally

```bash
cp .env.example .env.local
```

Fill in `COMFY_URL` and `COMFY_API_TOKEN`. Also generate an app token:

```bash
openssl rand -hex 32
```

That goes in `APP_ACCESS_TOKEN`. Optional locally; **mandatory before
deploying** — without it, anyone who finds the deployed URL drives their GPU.

Now the check that makes this runbook worth following:

```bash
pnpm check:nodes
```

It asks their ComfyUI whether every node class and model file the workflows name
is actually present, and reports which pack each class came from.

Read the output carefully and interpret it for them:

- **Cannot reach ComfyUI** — `COMFY_URL` is wrong, ComfyUI is not running, or
  the port is not open. Not a node problem.
- **Rejected the API token** — phase 3. Check the `$` escaping first; it is
  usually that. Note the script fails fast here rather than reporting 30 missing
  classes, so do not read this as "nothing is installed".
- **Specific classes NOT FOUND** — map them back to the packs in phase 1 and
  name the pack, not just the class.
- **Model files NOT FOUND** — the file is missing or misnamed. Offer both fixes:
  rename the file, or edit the loader input in the workflow.

Then:

```bash
pnpm check:workflows   # definitions agree with their own graphs; needs no ComfyUI
pnpm dev
```

Open <http://localhost:3000>. The header pill should read **Ready**. If it says
**Offline** or **Auth failed**, `/api/health` returns which in plain JSON — and
you can read it yourself rather than asking for a screenshot:

```bash
curl -s localhost:3000/api/health -H "x-app-token: $APP_ACCESS_TOKEN"
# want: "reachable":true,"authorized":true
```

Have them run one generation before deploying — **Text to Video** is the
cheapest test since it needs no upload. A first run proves the models load and
the gateway key on the ComfyUI host works, which no static check can.

## Phase 5 — Deploy to Vercel

Only once a local generation has actually succeeded. Deploying a setup that has
never worked just moves the debugging somewhere with worse feedback.

```bash
pnpm i -g vercel   # if needed
vercel login
vercel link
```

Then the environment. **No `$` escaping here** — these are literal:

```bash
vercel env add COMFY_URL production
vercel env add COMFY_API_TOKEN production
vercel env add APP_ACCESS_TOKEN production
```

`vercel env add` reads the value from the prompt or stdin. Do not pass
`NAME=value` as an argument.

Confirm `COMFY_URL` is the *public* one from phase 2, not `localhost`. This is
the single most common deployment failure and it is worth checking out loud.

**A private Blob store, for uploads over 4 MB.** Vercel refuses a function
request body over 4.5 MB, so a larger clip or track picked off disk goes from
the browser straight to Vercel Blob and is copied to ComfyUI from there, then
deleted. Without a store, small uploads still work and larger ones fail.

```bash
vercel blob create-store sorant-uploads --access private --yes
```

That connects it to the linked project and adds `BLOB_READ_WRITE_TOKEN` to
every environment — and **also rewrites `.env.local`**, pulling the project's
Development variables into it (including `APP_ACCESS_TOKEN`, which then gates
the local server too). It keeps local-only values such as `COMFY_API_TOKEN`,
but check the file afterwards. Cost is fractions of a cent per upload; nothing
stays stored. The ceiling is 100 MB, matching ComfyUI's `--max-upload-size
100`; raise `LARGE_UPLOAD_MAX_BYTES` in `src/lib/upload-limits.ts` together
with that flag.

Then:

```bash
vercel deploy --prod
```

Afterwards, verify: load the deployment, expect the token gate, enter the
`APP_ACCESS_TOKEN`, confirm the pill reads **Ready**, run one generation.

### If they connect the GitHub repo instead

Push to `main` deploys production; any other branch gets a preview. Two things
to tell them:

- Vercel Authentication does not cover production deployments on Hobby and Pro,
  so production is publicly reachable and `APP_ACCESS_TOKEN` is the only gate.
- If their fork is public, leave **Git Fork Protection** on (Project Settings →
  Security, on by default). It stops a stranger's pull request from building
  with their environment variables in scope — which would hand over the ComfyUI
  token. If they do not use preview deployments, removing `COMFY_URL` and
  `COMFY_API_TOKEN` from the Preview scope entirely is stronger still.

## When something is wrong

| Symptom | Look at |
| --- | --- |
| Pill reads **Offline** | `COMFY_URL`; ComfyUI running; port reachable from where the app runs |
| Pill reads **Auth failed** | `COMFY_API_TOKEN`; the `$` escaping; ComfyUI-Login enabled |
| Works locally, fails deployed | `COMFY_URL` is probably still `localhost`; or `$` was escaped in Vercel when it should not be |
| Valid token still rejected | ComfyUI started with `--enable-cors-header <specific-origin>` makes the bearer check unreachable. Drop the flag or set it to `*` |
| Generation fails on a node class | `pnpm check:nodes` — a pack is missing |
| Only the **Edit** button fails | The four FLUX Kontext files — `pnpm check:nodes` names whichever is missing |
| Upload over 4 MB fails on the deployment, works locally | No Blob store — see Phase 5 |
| Generation fails at the rewrite, no key | The gateway key on the ComfyUI host, not this app — header key button, or `AI_GATEWAY_API_KEY` |
| Generation fails at the rewrite, no reason | Usually a refusal. Change **Rewrite model** and try again |
| Refused: "the local director is chosen but … is not in" | The int8 Gemma file is not in `models/text_encoders/` — or switch the rewrite back to the gateway from the key button |
| A generation just stops | ComfyUI restarting drops its history; the job shows as **Lost** |
| "Contact was lost" | The connection dropped, not the workflow. Check the pill and resubmit — the run may have finished on the box |
| Rewrite refused: model not in the list | The gateway retired it. `pnpm sync:models`, then commit the regenerated file |
| The whole Windows machine dies or restarts during step 1 | `TdrDelay` / `TdrDdiDelay` not raised — see the end of Phase 1. Display event 4101 in the System log confirms it |

`/api/health` is the fastest single source of truth — it reports `reachable`,
`authorized` and `secure` separately, so it distinguishes "cannot connect" from
"connected but refused".

## Done when

Setup is finished when all of these are true, and not before:

- `pnpm check:nodes` exits 0 against the `COMFY_URL` the deployment uses.
- One generation has finished locally, and one on the deployment.
- The deployment asks for `APP_ACCESS_TOKEN` before anything else.
- If ComfyUI is reachable from the internet, ComfyUI-Login is on and the token
  has never crossed plain HTTP — or the person knows to rotate it.

Then tell the person what they skipped: optional files left out, switches they
will need to turn off because a pack is missing, and a Blob store not created.
