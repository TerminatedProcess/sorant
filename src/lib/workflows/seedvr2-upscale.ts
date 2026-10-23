import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, WorkflowDef } from "./types";
import {
  finalizeUpscale,
  frameRateParams,
  sourceVideoParam,
  upscaleFinalizeCases,
  upscaleGraph,
  VIDEO_NODE,
} from "./upscale-common";

/**
 * SeedVR2 upscale: a finished clip, made larger and given new fine detail,
 * sound untouched. The slow one — Upscale itself is RTX Video Super
 * Resolution, in rtx-upscale.ts; this is what the Add detail button runs.
 *
 * Flattened from Comfy-Org's "SeedVR2 3B Int8: Upscale Video" template — core
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

const SIZE_NODE = "3";
const POST_NODE = "13";

/**
 * Frames per batch: about four seconds of a 24 fps clip, so a 15-second H3
 * clip is four passes.
 *
 * 4n+1, which is the length SeedVR2's VAE takes without padding. Larger
 * batches mean fewer joins between independently upscaled stretches; smaller
 * ones mean less RAM per pass. At 1080 px a batch of this size is about 2.5 GB
 * per copy, which leaves room for every copy the graph makes and then some.
 */
const BATCH_FRAMES = 97;

const graph: ComfyGraph = upscaleGraph(BATCH_FRAMES, POST_NODE, {
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
    // About 180 seconds of work per second of clip at 1080 px. A minute is
    // three hours.
    "Its frame rate and soundtrack carry straight through. Up to 1080×1920 and a minute — which takes about three hours here.",
  ),
  {
    id: "shorter_side",
    label: "Output size",
    type: "slider",
    default: 1080,
    min: 720,
    max: 1080,
    step: 8,
    unit: "px",
    // The shorter side, so one number means the same thing in any aspect.
    help: "Height of a landscape clip, width of a portrait one. Time grows with the pixels: 1080 has 1.8× as many as 800.",
    group: "Output",
    targets: [{ node: SIZE_NODE, input: "resize_type.shorter_size" }],
  },
  {
    id: "upscale_model",
    label: "Model",
    type: "select",
    default: "seedvr2_7b_sharp_int8_convrot.safetensors",
    options: [
      {
        value: "seedvr2_7b_sharp_int8_convrot.safetensors",
        label: "7B sharp",
        help: "The more natural of the two: finer text, no halos.",
      },
      {
        value: "seedvr2_3b_int8_convrot.safetensors",
        label: "3B",
        help: "Less VRAM. Crisper, but harsher contrast and halos around edges.",
      },
    ],
    group: "Output",
    targets: [{ node: "6", input: "unet_name" }],
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
    targets: [{ node: POST_NODE, input: "color_correction_method" }],
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
    targets: [{ node: "10", input: "seed" }],
  },
];

export const seedvr2Upscale: WorkflowDef = {
  id: "seedvr2-upscale",
  name: "Add detail",
  description:
    "Upscales a finished clip with SeedVR2, which adds fine texture of its own — and shifts colour and faces a little. Slow.",
  // A 15-second H3 clip at 1080 px on the 3090, 7B sharp: 2700 s (1258 s at
  // 800). The client replaces it with this machine's median once a run has
  // finished.
  estimatedSeconds: 2700,
  hasAudio: true,
  graph,
  params,
  // No turbo, patches or director: there is no prompt and no H3 anywhere in
  // this graph, and the sampler is already a single step.
  //
  // RAM is what this graph runs short of, and an earlier H3 run leaves about
  // 23 GB of it holding models and cached results: 24.5 GB free on the box
  // before a free, 47.4 GB after. Batching bounds what a pass needs; this
  // gives the pass everything else.
  freesMemory: true,
  clipTarget: {
    action: "detail",
    accepts: "video",
    sourceParam: "source_video",
    // Every press starts at the defaults, as Upscale's does.
    fresh: true,
  },
  finalize: finalizeUpscale(POST_NODE),
  finalizeCases: upscaleFinalizeCases,
};
