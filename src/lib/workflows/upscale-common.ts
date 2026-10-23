import { isSilentClip } from "@/lib/audio-track";
import type { ComfyGraph } from "@/lib/comfy";
import type { ParamDef, ParamValue, WorkflowDef } from "./types";

/**
 * What the two upscales share: everything either side of the upscaler itself.
 *
 * Both run in VHS Meta Batch Manager passes (node 0) over a VHS-loaded clip
 * (nodes 1 and 2), may put RIFE or FILM frames between the upscaled ones
 * (nodes 15–20), and write one file at the clip's own rate with its own sound
 * (node 14). See upscale.ts for why each of those is the way it is; the
 * upscaler in the middle is all that differs, and `finalizeUpscale` is told
 * which node's frames come out of the one a run kept.
 */

export const MANAGER_NODE = "0";
export const VIDEO_NODE = "1";
export const INFO_NODE = "2";
export const COMBINE_NODE = "14";
const INTERP_MODEL_NODE = "15";
const INTERP_NODE = "16";
const PAD_REPEAT_NODE = "18";
const FPS_NODE = "20";
/** Every node that exists only for frame interpolation. */
const INTERP_NODES = ["15", "16", "17", "18", "19", "20"];
const RATE_PARAM = "frame_rate";

/** Unique per submission, so the run's re-queued passes can be told apart. */
const PREFIX = "video/upscale";

/** The multiplier a submission asked for: 1 when interpolation is off. */
function multiplierOf(values: Record<string, ParamValue>): number {
  const multiplier = Number(values[RATE_PARAM]);
  return Number.isInteger(multiplier) && multiplier >= 1 ? multiplier : 1;
}

/**
 * The shared nodes around an upscaler: `framesPerBatch` frames per pass, and
 * `upscaled` the node whose output is the finished frames.
 */
export function upscaleGraph(
  framesPerBatch: number,
  upscaled: string,
  upscaler: ComfyGraph,
): ComfyGraph {
  return {
    [MANAGER_NODE]: {
      class_type: "VHS_BatchManager",
      inputs: { frames_per_batch: framesPerBatch },
      _meta: { title: "Meta Batch Manager" },
    },
    [VIDEO_NODE]: {
      class_type: "VHS_LoadVideo",
      inputs: {
        video: "",
        force_rate: 0,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
        meta_batch: [MANAGER_NODE, 0],
      },
      _meta: { title: "Load Video" },
    },
    [INFO_NODE]: {
      class_type: "VHS_VideoInfoLoaded",
      inputs: { video_info: [VIDEO_NODE, 3] },
      _meta: { title: "Video Info (Loaded)" },
    },

    ...upscaler,

    // Frame interpolation, removed by `finalize` when it is off. The loader is
    // core ComfyUI's, which reads RIFE and FILM checkpoints alike.
    [INTERP_MODEL_NODE]: {
      class_type: "FrameInterpolationModelLoader",
      inputs: { model_name: "rife_v4.26.safetensors" },
      _meta: { title: "Load Frame Interpolation Model" },
    },
    // N frames in, (N − 1) × multiplier + 1 out: nothing after the last frame.
    [INTERP_NODE]: {
      class_type: "FrameInterpolate",
      inputs: { interp_model: [INTERP_MODEL_NODE, 0], images: [upscaled, 0], multiplier: 2 },
      _meta: { title: "Run Frame Interpolation Model" },
    },
    // The batch's last frame, repeated multiplier − 1 times and appended, so
    // the batch comes out at exactly N × multiplier frames. The slots it fills
    // are the ones the next batch's first frame would have been blended into.
    "17": {
      class_type: "ImageFromBatch",
      inputs: { image: [upscaled, 0], batch_index: -1, length: 1 },
      _meta: { title: "Last Frame" },
    },
    [PAD_REPEAT_NODE]: {
      class_type: "RepeatImageBatch",
      inputs: { image: ["17", 0], amount: 1 },
      _meta: { title: "Repeat Last Frame" },
    },
    "19": {
      class_type: "ImageBatch",
      inputs: { image1: [INTERP_NODE, 0], image2: [PAD_REPEAT_NODE, 0] },
      _meta: { title: "Pad Batch" },
    },
    // The source's rate times the multiplier, for the combine to write at.
    [FPS_NODE]: {
      class_type: "ComfyMathExpression",
      inputs: { expression: "a * b", "values.a": [INFO_NODE, 0], "values.b": 2 },
      _meta: { title: "Output Frame Rate" },
    },

    // VHS's combine rather than core SaveVideo: it is the one that can hold a
    // file open across the batch manager's passes. H.264 at CRF 17, near enough
    // lossless at these sizes, since this is the copy someone keeps.
    [COMBINE_NODE]: {
      class_type: "VHS_VideoCombine",
      inputs: {
        images: ["19", 0],
        audio: [VIDEO_NODE, 2],
        frame_rate: [FPS_NODE, 0],
        loop_count: 0,
        filename_prefix: PREFIX,
        format: "video/h264-mp4",
        pix_fmt: "yuv420p",
        crf: 17,
        save_metadata: false,
        trim_to_audio: false,
        pingpong: false,
        save_output: true,
        meta_batch: [MANAGER_NODE, 0],
      },
      _meta: { title: "Video Combine" },
    },
  };
}

/** The clip to upscale, with what it costs per second said in `help`. */
export function sourceVideoParam(help: string): ParamDef {
  return {
    id: "source_video",
    label: "Clip to upscale",
    type: "video",
    default: "",
    required: true,
    help,
    group: "Source",
    // Not H3's 768×1344: the source is resized to the output size anyway, so
    // a phone's 1080p clip is fine.
    maxShortEdge: 1080,
    maxLongEdge: 1920,
    // Batched, so length costs time, not memory.
    maxSeconds: 60,
    targets: [{ node: VIDEO_NODE, input: "video" }],
  };
}

/** Frame rate and the model that makes the new frames, last in the form. */
export const frameRateParams: ParamDef[] = [
  {
    id: RATE_PARAM,
    label: "Frame rate",
    type: "select",
    default: "1",
    options: [
      {
        value: "1",
        label: "Keep the clip's",
        help: "No new frames — 24 fps for an H3 clip.",
      },
      {
        value: "2",
        label: "Double it",
        help: "A new frame between every pair: 48 fps from H3's 24. Smoother motion, and adds a few minutes.",
      },
    ],
    help: "Smooths motion by adding in-between frames after the upscale. The soundtrack is unchanged.",
    group: "Output",
    targets: [
      {
        node: INTERP_NODE,
        input: "multiplier",
        transform: (_value, values) => Math.max(2, multiplierOf(values)),
      },
      {
        node: PAD_REPEAT_NODE,
        input: "amount",
        transform: (_value, values) => Math.max(1, multiplierOf(values) - 1),
      },
      {
        node: FPS_NODE,
        input: "values.b",
        transform: (_value, values) => multiplierOf(values),
      },
    ],
  },
  {
    id: "interpolation_model",
    label: "Interpolation model",
    type: "select",
    default: "rife_v4.26.safetensors",
    options: [
      {
        value: "rife_v4.26.safetensors",
        label: "RIFE 4.26",
        help: "Fast, and the usual choice.",
      },
      {
        value: "film_net_fp16.safetensors",
        label: "FILM",
        help: "Better through big, fast movement, and much slower.",
      },
    ],
    group: "Output",
    advanced: true,
    hiddenBy: { param: RATE_PARAM, is: "1" },
    targets: [{ node: INTERP_MODEL_NODE, input: "model_name" }],
  },
];

/**
 * A filename prefix of the run's own, and the pieces a run does not use taken
 * out. `upscaled` is the node whose frames the combine takes when no new
 * frames are made.
 */
export function finalizeUpscale(upscaled: string): NonNullable<WorkflowDef["finalize"]> {
  return (graph, values) => {
    // VHS re-queues this graph under new prompt ids, and the prefix is what
    // the status and cancel routes find those passes by — so two upscales
    // queued together must not share one. See meta-batch.ts.
    graph[COMBINE_NODE].inputs.filename_prefix =
      `${PREFIX}_${crypto.randomUUID().slice(0, 8)}`;

    // Frame interpolation off: the combine takes the upscale straight, at the
    // source's own rate, and the interpolation nodes go — a loader left in
    // would still be validated, and fail on a box without the model file.
    if (multiplierOf(values) === 1) {
      graph[COMBINE_NODE].inputs.images = [upscaled, 0];
      graph[COMBINE_NODE].inputs.frame_rate = [INFO_NODE, 0];
      for (const node of INTERP_NODES) delete graph[node];
    } else {
      graph[INTERP_NODE].inputs.images = [upscaled, 0];
      graph["17"].inputs.image = [upscaled, 0];
    }

    // A source with no soundtrack comes out without one, rather than failing:
    // VHS decodes a clip's audio the first time something reads it, and on a
    // file with no audio stream that decode raises. The combine's audio is
    // optional. See storedClipName.
    if (isSilentClip(values.source_video)) {
      delete graph[COMBINE_NODE].inputs.audio;
    }
  };
}

export const upscaleFinalizeCases: NonNullable<WorkflowDef["finalizeCases"]> = [
  { name: "frame rate kept", values: { source_video: "clip.mp4" } },
  { name: "a silent source", values: { source_video: "noaudio--clip.mp4" } },
  {
    name: "frame rate doubled",
    values: { source_video: "clip.mp4", [RATE_PARAM]: "2" },
  },
  {
    name: "frame rate doubled with FILM",
    values: {
      source_video: "clip.mp4",
      [RATE_PARAM]: "2",
      interpolation_model: "film_net_fp16.safetensors",
    },
  },
];
