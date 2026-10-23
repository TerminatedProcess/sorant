import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, WorkflowDef } from "./types";
import {
  finalizeUpscale,
  frameRateParams,
  INFO_NODE,
  sourceVideoParam,
  upscaleFinalizeCases,
  upscaleGraph,
  VIDEO_NODE,
} from "./upscale-common";

/**
 * Upscale: a finished clip, made larger and sharper by NVIDIA's RTX Video
 * Super Resolution, sound untouched.
 *
 * Chosen over SeedVR2 (seedvr2-upscale.ts, now the Add detail button) after an
 * A/B on the 3090, 2026-10-23, on a 5-second H3 clip to 1080 px:
 *
 * - **Speed.** 8.9 s against SeedVR2 7B sharp's 14 min 23 s — and 22.8 s all
 *   the way to 4K. It uses about 1.4 GB of VRAM and no model download.
 * - **Faithfulness.** It sharpens what is there and keeps the source's colour
 *   and shading. SeedVR2 measured more fine detail (2.74 against 2.50 on a
 *   gradient-energy measure, the source 2.07) but warmed the colour, raised
 *   the contrast and reshaded the face. Neither added flicker.
 *
 * So this is the default, and SeedVR2 stays for a soft source that wants
 * detail invented. The pack is Comfy-Org's ComfyUI_Nvidia_VFX_Nodes; it needs
 * an RTX card and CUDA 13 PyTorch, and its `nvidia-vfx` dependency comes from
 * NVIDIA's own package index.
 *
 * The node scales by a multiplier (1–4) or to exact dimensions, where the form
 * asks for a shorter side. So node 3 works the multiplier out from the clip's
 * own size, and node 5 resizes to the exact shorter side afterwards — the node
 * rounds its output to a multiple of 8, and a source already larger than the
 * asked-for size is scaled down there rather than refused by the node.
 */

const SCALE_NODE = "3";
const VSR_NODE = "4";
const SIZE_NODE = "5";

/**
 * Frames per batch, about two seconds of a 24 fps clip. Smaller than SeedVR2's
 * because the output can be 4K, where a frame is about 100 MB as fp32; per
 * pass this upscaler costs nothing to load, so more passes cost little.
 */
const BATCH_FRAMES = 49;

const graph: ComfyGraph = upscaleGraph(BATCH_FRAMES, SIZE_NODE, {
  // The shorter side asked for over the clip's own, held to what the node
  // takes. Below 1 the node is skipped in effect, and node 5 scales down.
  [SCALE_NODE]: {
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
      "resize_type.scale": [SCALE_NODE, 0],
      quality: "ULTRA",
      strength: 1,
      image_encoding: "8-bit RGB",
    },
    _meta: { title: "RTX Video Super Resolution" },
  },
  [SIZE_NODE]: {
    class_type: "ResizeImageMaskNode",
    inputs: {
      input: [VSR_NODE, 0],
      resize_type: "scale shorter dimension",
      "resize_type.shorter_size": 1080,
      scale_method: "lanczos",
    },
    _meta: { title: "Resize Image/Mask" },
  },
});

const params: ParamDef[] = [
  sourceVideoParam(
    // About two seconds of work per second of clip at 1080 px, and four or
    // five at 4K, on the 3090.
    "Its frame rate and soundtrack carry straight through. Up to 1080×1920 and a minute.",
  ),
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
    help: "Height of a landscape clip, width of a portrait one: 1080 is HD, 2160 is 4K. 4K takes about twice as long and makes a file about four times the size.",
    group: "Output",
    targets: [
      { node: SCALE_NODE, input: "values.c" },
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
    targets: [{ node: VSR_NODE, input: "quality" }],
  },
  ...frameRateParams,
];

export const rtxUpscale: WorkflowDef = {
  id: "rtx-upscale",
  name: "Upscale",
  description: "Makes a finished clip larger and sharper, up to 4K, keeping its sound. Seconds, not minutes.",
  // A 15-second H3 clip at 1080 px on the 3090, from 8.9 s for five seconds
  // plus a pass's overhead per batch. The client replaces it with this
  // machine's median once a run has finished.
  estimatedSeconds: 40,
  hasAudio: true,
  graph,
  params,
  // No turbo, patches or director, and no freesMemory: the upscaler loads in
  // a second and fits in under 2 GB beside whatever an earlier run left.
  clipTarget: {
    action: "upscale",
    accepts: "video",
    sourceParam: "source_video",
    // Every press of Upscale starts at the defaults, as it was asked to.
    fresh: true,
  },
  finalize: finalizeUpscale(SIZE_NODE),
  finalizeCases: upscaleFinalizeCases,
};
