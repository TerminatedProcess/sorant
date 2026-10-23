import type { ComfyGraph } from "@/lib/comfy";
import { ParamError } from "@/lib/params";
import type { ParamDef, ParamValue, WorkflowDef } from "./types";
import {
  finalizeUpscale,
  frameRateParams,
  INFO_NODE,
  MANAGER_NODE,
  sourceVideoParam,
  upscaleFinalizeCases,
  upscaleGraph,
  VIDEO_NODE,
} from "./upscale-common";

/**
 * Upscale: a finished clip, made larger and sharper, sound untouched — by one
 * of two upscalers, chosen in the form. `finalize` keeps the chosen one's
 * nodes and deletes the other's.
 *
 * **RTX Video Super Resolution** is the default (nodes vsr_*). It replaced
 * SeedVR2 after an A/B on the 3090, 2026-10-23, on a 5-second H3 clip to
 * 1080 px: 8.9 s against SeedVR2 7B sharp's 14 min 23 s, and 22.8 s all the way
 * to 4K, in about 1.4 GB of VRAM with no model download. It sharpens what is
 * there and keeps the source's colour and shading. The pack is Comfy-Org's
 * ComfyUI_Nvidia_VFX_Nodes; it needs an RTX card and CUDA 13 PyTorch, and its
 * `nvidia-vfx` dependency comes from NVIDIA's own package index. The node
 * scales by a multiplier (1–4) where the form asks for a shorter side, so
 * vsr_scale works the multiplier out from the clip's own size and vsr_size
 * resizes to the exact shorter side afterwards — the node rounds its output to
 * a multiple of 8, and a source already larger than asked is scaled down there
 * rather than refused.
 *
 * **SeedVR2** (nodes 3–13) measured more fine detail (2.74 against 2.50 on a
 * gradient-energy measure, the source 2.07) but warmed the colour, raised the
 * contrast and reshaded the face — and takes about a hundred times as long.
 * It stays for a soft source that wants detail invented. Flattened from Comfy-Org's "SeedVR2 3B Int8: Upscale Video" template — core
 * nodes for the model, VHS for the video either side of it — with changes
 * each of which was measured on the 3090 before it went in:
 *
 * 1. **It runs in batches.** Every node between the loader and the save holds
 *    its whole input as fp32 frames at the output size, and ComfyUI keeps each
 *    one's output until the run ends. At 1080 px a 15-second clip is about 9 GB
 *    per copy, and the colour match alone makes five or six more while it
 *    works, so a whole clip at once ran a 64 GB box out of RAM — at 1080 even
 *    straight after freeing it, 45 minutes in. VHS's Meta Batch Manager (node
 *    0) instead loads BATCH_FRAMES at a time, runs the graph on them, and
 *    appends the result to one file node 14 holds open, re-queueing the graph
 *    itself until the clip runs out. RAM then follows the batch, not the clip.
 *    The app follows the run across those re-queued prompts by the combine
 *    node's filename prefix, which `finalize` makes unique; see meta-batch.ts.
 * 2. **Fixed temporal chunks.** The template's `SeedVR2TemporalChunk` is on
 *    "auto", which sizes chunks to the VRAM that happens to be free. Straight
 *    after an H3 run that is about 9 GB, and auto answered with *one frame per
 *    chunk* — which samples every frame on its own, so nothing holds the
 *    upscale steady from one frame to the next. 21 frames (SeedVR2 wants 4n+1)
 *    is what the template's manual mode defaults to, and fits beside anything.
 * 3. **1024 px VAE tiles**, not 512. The SeedVR2 VAE is the whole cost of this
 *    graph — the sampler is one step and takes seconds; encode and decode take
 *    minutes — and at 512 a 3-second test spent 851 s in it against 399 s at
 *    1024. Larger again, or untiled, measured no faster.
 * 4. **The clip's own frame rate and audio** go back on at the end, so the
 *    result plays exactly as long as the source and keeps its soundtrack. The
 *    loader hands the combine node the whole file's audio on every pass, and
 *    the combine node muxes it once, when the last batch closes the file.
 *
 * 5. **Optional frame interpolation** after the upscale (nodes 15–20): RIFE
 *    puts new frames between the upscaled ones, and the combine writes at the
 *    raised rate. It runs per batch like everything else, which leaves one gap
 *    at each join: a batch's last frame and the next batch's first are never
 *    seen together, so nothing is made between them. Each batch is padded with
 *    copies of its last frame to fill that slot, which keeps the frame count —
 *    and so the sync with the audio — exact, at the cost of one held frame per
 *    join instead of a skipped one. See `finalize` for the switch.
 *
 * The loader is VHS rather than core for the same reason as Extend's: it reads
 * the fragmented MP4 a browser's recorder writes, which the core loader
 * measures as a single frame — and it is the loader the batch manager drives.
 * `force_rate: 0` leaves the rate as it is.
 */

const UPSCALER_PARAM = "upscaler";
const VSR = "vsr";
const SEEDVR2_7B = "seedvr2_7b_sharp_int8_convrot.safetensors";
const SEEDVR2_3B = "seedvr2_3b_int8_convrot.safetensors";

const VSR_SCALE_NODE = "vsr_scale";
const VSR_NODE = "vsr";
const VSR_SIZE_NODE = "vsr_size";
const VSR_NODES = [VSR_SCALE_NODE, VSR_NODE, VSR_SIZE_NODE];

const SIZE_NODE = "3";
const SEEDVR2_POST = "13";
const SEEDVR2_NODES = ["3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"];
/** SeedVR2 holds every frame at the output size in RAM several times over. */
const SEEDVR2_MAX_SIDE = 1080;

const isSeedVR2 = (values: Record<string, ParamValue>) => values[UPSCALER_PARAM] !== VSR;

/**
 * Frames per pass. SeedVR2's is about four seconds of a 24 fps clip and 4n+1,
 * the length its VAE takes without padding; at 1080 px that is about 2.5 GB
 * per copy, which leaves room for every copy the graph makes. VSR's is half
 * that, because its output can be 4K, where a frame is about 100 MB as fp32 —
 * and it costs nothing to load, so more passes cost little.
 */
const SEEDVR2_BATCH_FRAMES = 97;
const VSR_BATCH_FRAMES = 49;

const graph: ComfyGraph = upscaleGraph(VSR_BATCH_FRAMES, VSR_SIZE_NODE, {
  // The shorter side asked for over the clip's own, held to what the node
  // takes. Below 1 the node is skipped in effect, and vsr_size scales down.
  [VSR_SCALE_NODE]: {
    class_type: "ComfyMathExpression",
    inputs: {
      expression: "min(4, max(1, c / min(a, b)))",
      "values.a": [INFO_NODE, 3],
      "values.b": [INFO_NODE, 4],
      "values.c": 1080,
    },
    _meta: { title: "Scale Factor" },
  },
  [VSR_NODE]: {
    class_type: "RTXVideoSuperResolution",
    inputs: {
      images: [VIDEO_NODE, 0],
      resize_type: "scale by multiplier",
      "resize_type.scale": [VSR_SCALE_NODE, 0],
      quality: "ULTRA",
      strength: 1,
      image_encoding: "8-bit RGB",
    },
    _meta: { title: "RTX Video Super Resolution" },
  },
  [VSR_SIZE_NODE]: {
    class_type: "ResizeImageMaskNode",
    inputs: {
      input: [VSR_NODE, 0],
      resize_type: "scale shorter dimension",
      "resize_type.shorter_size": 1080,
      scale_method: "lanczos",
    },
    _meta: { title: "Resize Image/Mask" },
  },

  // The size is set here, in pixels, before the model sees anything: SeedVR2
  // restores detail at whatever size it is given rather than choosing one. The
  // same resized frames are the reference the colour correction matches.
  "3": {
    class_type: "ResizeImageMaskNode",
    inputs: {
      input: [VIDEO_NODE, 0],
      resize_type: "scale shorter dimension",
      "resize_type.shorter_size": 1080,
      scale_method: "lanczos",
    },
    _meta: { title: "Resize Image/Mask" },
  },
  "4": {
    class_type: "SeedVR2Preprocess",
    inputs: { resized_images: ["3", 0] },
    _meta: { title: "SeedVR2 Preprocess" },
  },

  "5": {
    class_type: "VAELoader",
    inputs: { vae_name: "seedvr2_ema_vae_fp16.safetensors" },
    _meta: { title: "Load VAE" },
  },
  "6": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "seedvr2_7b_sharp_int8_convrot.safetensors",
      weight_dtype: "default",
    },
    _meta: { title: "Load Diffusion Model" },
  },

  "7": {
    class_type: "VAEEncodeTiled",
    inputs: {
      pixels: ["4", 0],
      vae: ["5", 0],
      tile_size: 1024,
      overlap: 128,
      temporal_size: 64,
      temporal_overlap: 8,
    },
    _meta: { title: "VAE Encode (Tiled)" },
  },
  "8": {
    class_type: "SeedVR2TemporalChunk",
    inputs: {
      latent: ["7", 0],
      temporal_overlap: 1,
      chunking_mode: "manual",
      "chunking_mode.frames_per_chunk": 21,
    },
    _meta: { title: "Split SeedVR2 Latent" },
  },
  "9": {
    class_type: "SeedVR2Conditioning",
    inputs: { model: ["6", 0], vae_conditioning: ["8", 0] },
    _meta: { title: "Apply SeedVR2 Conditioning" },
  },
  // One step at full denoise is the model's design, not a speed setting.
  "10": {
    class_type: "KSampler",
    inputs: {
      model: ["6", 0],
      positive: ["9", 0],
      negative: ["9", 1],
      latent_image: ["8", 0],
      seed: 0,
      steps: 1,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
    },
    _meta: { title: "KSampler" },
  },
  "11": {
    class_type: "SeedVR2TemporalMerge",
    inputs: { latents: ["10", 0], temporal_overlap: ["8", 1] },
    _meta: { title: "Merge SeedVR2 Latents" },
  },
  "12": {
    class_type: "VAEDecodeTiled",
    inputs: {
      samples: ["11", 0],
      vae: ["5", 0],
      tile_size: 1024,
      overlap: 128,
      temporal_size: 64,
      temporal_overlap: 8,
    },
    _meta: { title: "VAE Decode (Tiled)" },
  },
  "13": {
    class_type: "SeedVR2PostProcessing",
    inputs: {
      images: ["12", 0],
      original_resized_images: ["3", 0],
      color_correction_method: "lab",
    },
    _meta: { title: "Post-Process SeedVR2 Output" },
  },

});

const params: ParamDef[] = [
  sourceVideoParam(
    // VSR: about two seconds of work per second of clip at 1080 px, and ten at
    // 4K, on the 3090. SeedVR2: about 180 at 1080 px, so a minute is three
    // hours.
    "Its frame rate and soundtrack carry straight through. Up to 1080×1920 and a minute.",
  ),
  {
    id: UPSCALER_PARAM,
    label: "Upscaler",
    type: "select",
    default: VSR,
    options: [
      {
        value: VSR,
        label: "RTX Video",
        help: "Sharpens what is there and keeps the clip's colour and faces. Seconds, up to 4K. Needs an NVIDIA RTX card.",
      },
      {
        value: SEEDVR2_7B,
        label: "SeedVR2 7B — very slow",
        help: "Invents fine texture, and shifts colour and faces a little. About 45 minutes for a 15-second clip at 1080 px. Up to 1080 px.",
      },
      {
        value: SEEDVR2_3B,
        label: "SeedVR2 3B — very slow",
        help: "Less VRAM than 7B, harsher contrast and halos around edges. Nearly as slow: tens of minutes a clip. Up to 1080 px.",
      },
    ],
    help: "RTX Video for almost everything. SeedVR2 for a soft clip that needs detail made up — and expect to wait a long time.",
    group: "Output",
    // The loader's file when SeedVR2 is chosen. VSR keeps 7B's in a node
    // `finalize` deletes.
    targets: [
      {
        node: "6",
        input: "unet_name",
        transform: (value) => (value === VSR ? SEEDVR2_7B : value),
      },
    ],
  },
  {
    id: "shorter_side",
    label: "Output size",
    type: "slider",
    default: 1080,
    min: 720,
    max: 2160,
    step: 8,
    unit: "px",
    // The shorter side, so one number means the same thing in any aspect.
    help: "Height of a landscape clip, width of a portrait one: 1080 is HD, 2160 is 4K. SeedVR2 goes up to 1080.",
    group: "Output",
    targets: [
      { node: VSR_SCALE_NODE, input: "values.c" },
      { node: VSR_SIZE_NODE, input: "resize_type.shorter_size" },
      { node: SIZE_NODE, input: "resize_type.shorter_size" },
    ],
  },
  {
    id: "quality",
    label: "Mode",
    type: "select",
    default: "ULTRA",
    options: [
      {
        value: "ULTRA",
        label: "Standard",
        help: "For compressed video, which every H3 clip is: cleans up the compression as it sharpens.",
      },
      {
        value: "HIGHBITRATE_ULTRA",
        label: "Clean source",
        help: "For a clean, high-bitrate source: leaves the picture alone apart from the sharpening. A little softer on an H3 clip.",
      },
    ],
    group: "Output",
    hiddenBy: [
      { param: UPSCALER_PARAM, is: SEEDVR2_7B },
      { param: UPSCALER_PARAM, is: SEEDVR2_3B },
    ],
    targets: [{ node: VSR_NODE, input: "quality" }],
  },
  {
    id: "color_correction",
    label: "Colour match",
    type: "select",
    // LAB, measured over a whole 15-second clip at 800 px: frame-to-frame
    // colour drift against the source of 0.22 levels on average and 2.4 at
    // worst, against 1.62 and 16 with it off — SeedVR2 on its own lets colour
    // wander from frame to frame, which reads as blips in playback. A single
    // frame side by side shows none of that, which is how Off was briefly the
    // default. Per batch it costs about 20 seconds a clip and no RAM to speak
    // of; on a whole clip at once its copies were what ran the box out.
    default: "lab",
    options: [
      {
        value: "lab",
        label: "LAB",
        help: "Holds every frame's colour to the source's, so it doesn't drift or blip. The default.",
      },
      {
        value: "wavelet",
        label: "Wavelet",
        help: "Matches the broad colour and keeps all the new detail.",
      },
      {
        value: "adain",
        label: "AdaIN",
        help: "One overall tint match per frame — the lightest touch.",
      },
      {
        value: "none",
        label: "Off",
        help: "The model's own colours. They wander a little from frame to frame, which shows as colour blips.",
      },
    ],
    help: "Re-matches the upscale's colours to the source's, frame by frame, after upscaling.",
    group: "Output",
    hiddenBy: { param: UPSCALER_PARAM, is: VSR },
    targets: [{ node: SEEDVR2_POST, input: "color_correction_method" }],
  },
  ...frameRateParams,
  {
    id: "seed",
    label: "Seed",
    type: "seed",
    default: -1,
    help: "One step from the clip itself, so this changes very little.",
    group: "Output",
    advanced: true,
    hiddenBy: { param: UPSCALER_PARAM, is: VSR },
    targets: [{ node: "10", input: "seed" }],
  },
];

export const upscale: WorkflowDef = {
  id: "upscale",
  name: "Upscale",
  description: "Makes a finished clip larger and sharper, up to 4K, keeping its sound.",
  // A 15-second H3 clip at 1080 px on the 3090: about 40 s with RTX Video,
  // 2700 s with SeedVR2 7B sharp (1258 s at 800). The client replaces these
  // with this machine's median, per upscaler, once a run has finished.
  estimatedSeconds: 40,
  estimateBy: {
    param: UPSCALER_PARAM,
    seconds: { [VSR]: 40, [SEEDVR2_7B]: 2700, [SEEDVR2_3B]: 2700 },
  },
  hasAudio: true,
  graph,
  params,
  optionalNodes: SEEDVR2_NODES,
  // No turbo, patches or director: there is no prompt and no H3 anywhere in
  // this graph.
  //
  // RAM is what SeedVR2 runs short of, and an earlier H3 run leaves about
  // 23 GB of it holding models and cached results: 24.5 GB free on the box
  // before a free, 47.4 GB after. Batching bounds what a pass needs; this
  // gives the pass everything else. VSR fits in under 2 GB beside whatever is
  // cached, and freeing would only make the next run reload its models.
  freesMemory: isSeedVR2,
  clipTarget: {
    action: "upscale",
    accepts: "video",
    sourceParam: "source_video",
    // Every press of Upscale starts at the defaults, as it was asked to.
    fresh: true,
  },
  finalize: (graph, values) => {
    const seedvr2 = isSeedVR2(values);
    if (seedvr2 && Number(values.shorter_side) > SEEDVR2_MAX_SIDE) {
      throw new ParamError(
        `SeedVR2 goes up to ${SEEDVR2_MAX_SIDE} px. Choose RTX Video for a larger size.`,
        "shorter_side",
      );
    }
    for (const node of seedvr2 ? VSR_NODES : SEEDVR2_NODES) delete graph[node];
    graph[MANAGER_NODE].inputs.frames_per_batch = seedvr2
      ? SEEDVR2_BATCH_FRAMES
      : VSR_BATCH_FRAMES;
    finalizeUpscale(seedvr2 ? SEEDVR2_POST : VSR_SIZE_NODE)(graph, values);
  },
  finalizeCases: [
    ...upscaleFinalizeCases,
    ...upscaleFinalizeCases.map(({ name, values }) => ({
      name: `${name}, SeedVR2`,
      values: { ...values, [UPSCALER_PARAM]: SEEDVR2_7B },
    })),
  ],
};
