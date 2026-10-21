import type { ComfyGraph } from "@/lib/comfy";
import { ParamError } from "@/lib/params";
import {
  EDIT_GUIDANCE_NODE,
  EDIT_SAMPLER_NODE,
  IMAGE_EDIT_SETTINGS,
} from "./image-edit-settings";
import type { ParamDef, WorkflowDef } from "./types";

/**
 * FLUX.1 Kontext dev: a reference picture, changed by a sentence.
 *
 * Not a generator — the Edit button on an image control queues it and writes
 * the result back into that control. Core nodes only, laid out the way
 * Comfy-Org's Kontext template wires them, with these choices measured on the
 * 3090 before they went in:
 *
 * 1. **20 steps of ER-SDE on the Beta schedule, guidance 2.5.** Chosen from a
 *    same-seed grid on a portrait (2026-10-21): the template's Euler/Simple —
 *    at 8 steps or 20, guidance 1.5 to 2.5 — redrew the man as somebody else,
 *    darker-skinned and bearded, with Kontext's smooth, contrasty polish.
 *    ER-SDE kept his face, skin tone and stubble, with pores and freckles
 *    rather than plastic. About a minute a run where 8 Euler steps took 18 s
 *    warm. Cold — straight after a free, or after an H3 run evicted it — adds
 *    10 to 15 s. An H3 run straight after an edit took about 18 s longer than
 *    a warm one, which is the swap, and nothing worse: the box stayed up.
 * 2. **fp8 weights.** The file is bf16 and would not leave the T5 room on a
 *    24 GB card; cast on load, it does.
 * 3. **The picture's own shape.** `ImageScaleToTotalPixels` to 1 MP on a 16 px
 *    grid, rather than the template's `FluxKontextImageScale`, which snaps to
 *    Kontext's preferred sizes and would change the frame an image-to-video run
 *    inherits. 1 MP is also where H3 stops, so nothing past it would be used.
 * 4. **No identity suffix.** The instruction goes in as typed — no rewrite, no
 *    boilerplate. At the defaults above an outfit change kept the face without
 *    being told to.
 *
 * Guidance, steps, sampler, schedule and how much of the picture is redrawn
 * are the user's from the settings button on the edit bar — see
 * image-edit-settings.ts, which holds the defaults. The graph's own values
 * below are the template's and are always overwritten.
 */

const IMAGE_NODE = "10";
const PROMPT_NODE = "4";
const SAMPLER_NODE = EDIT_SAMPLER_NODE;
const SAVE_NODE = "9";
const INSTRUCTION_PARAM = "instruction";

const graph: ComfyGraph = {
  "1": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "flux1-kontext-dev.safetensors",
      weight_dtype: "fp8_e4m3fn",
    },
  },
  "2": {
    class_type: "DualCLIPLoader",
    inputs: {
      clip_name1: "clip_l.safetensors",
      clip_name2: "t5xxl_fp8_e4m3fn.safetensors",
      type: "flux",
    },
  },
  "3": {
    class_type: "VAELoader",
    inputs: { vae_name: "ae.safetensors" },
  },
  [IMAGE_NODE]: {
    class_type: "LoadImage",
    inputs: { image: "example.png" },
  },
  "11": {
    class_type: "ImageScaleToTotalPixels",
    inputs: {
      image: [IMAGE_NODE, 0],
      upscale_method: "lanczos",
      megapixels: 1,
      resolution_steps: 16,
    },
  },
  "12": {
    class_type: "VAEEncode",
    inputs: { pixels: ["11", 0], vae: ["3", 0] },
  },
  [PROMPT_NODE]: {
    class_type: "CLIPTextEncode",
    inputs: { clip: ["2", 0], text: "" },
  },
  "13": {
    class_type: "ReferenceLatent",
    inputs: { conditioning: [PROMPT_NODE, 0], latent: ["12", 0] },
  },
  [EDIT_GUIDANCE_NODE]: {
    class_type: "FluxGuidance",
    inputs: { conditioning: ["13", 0], guidance: 2.5 },
  },
  "5": {
    class_type: "ConditioningZeroOut",
    inputs: { conditioning: [PROMPT_NODE, 0] },
  },
  [SAMPLER_NODE]: {
    class_type: "KSampler",
    inputs: {
      model: ["1", 0],
      seed: 0,
      steps: 8,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      positive: ["14", 0],
      negative: ["5", 0],
      // The picture's own latent. At full denoise only its size survives,
      // which is what sizes the output to match the input; below it, the
      // picture itself is where sampling starts. See `redraw`.
      latent_image: ["12", 0],
      denoise: 1,
    },
  },
  "8": {
    class_type: "VAEDecode",
    inputs: { samples: [SAMPLER_NODE, 0], vae: ["3", 0] },
  },
  [SAVE_NODE]: {
    class_type: "SaveImage",
    inputs: { images: ["8", 0], filename_prefix: "edits/edit" },
  },
};

const params: ParamDef[] = [
  {
    id: "image",
    label: "Image",
    type: "image",
    default: "",
    required: true,
    targets: [{ node: IMAGE_NODE, input: "image" }],
  },
  {
    id: INSTRUCTION_PARAM,
    label: "Change",
    type: "text",
    default: "",
    maxLength: 1000,
    targets: [{ node: PROMPT_NODE, input: "text" }],
  },
  {
    id: "seed",
    label: "Seed",
    type: "seed",
    default: -1,
    targets: [{ node: SAMPLER_NODE, input: "seed" }],
  },
  ...IMAGE_EDIT_SETTINGS,
];

export const imageEdit: WorkflowDef = {
  id: "image-edit",
  name: "Edit image",
  description: "Changes a reference picture by a sentence.",
  estimatedSeconds: 60,
  graph,
  params,
  tool: true,
  finalize: (graph, values) => {
    // An empty instruction, which Kontext would answer with a lightly redrawn
    // copy of the picture — 20 seconds for nothing.
    if (!String(values[INSTRUCTION_PARAM] ?? "").trim()) {
      throw new ParamError("Say what should change.", INSTRUCTION_PARAM);
    }
    // A name of the run's own. The result is copied into the input directory
    // by name, overwriting, and an output counter restarts when that directory
    // is cleared — so a shared prefix could land a new edit on top of an old
    // one a slot still points at.
    graph[SAVE_NODE].inputs.filename_prefix =
      `edits/edit_${crypto.randomUUID().slice(0, 8)}`;
  },
  finalizeCases: [
    {
      name: "an instruction",
      values: { image: "example.png", [INSTRUCTION_PARAM]: "make it night" },
    },
    {
      name: "tuned settings",
      values: {
        image: "example.png",
        [INSTRUCTION_PARAM]: "make it night",
        guidance: 1.8,
        steps: 20,
        redraw: 0.8,
        sampler: "deis",
        scheduler: "beta",
      },
    },
    {
      name: "no instruction",
      values: { image: "example.png", [INSTRUCTION_PARAM]: "  " },
      rejects: "Say what should change",
    },
  ],
};
