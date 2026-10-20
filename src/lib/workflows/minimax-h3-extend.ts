import type { ComfyGraph } from "@/lib/comfy";
import { ParamError } from "@/lib/params";
import { hideDirectorOnly } from "./director";
import {
  latentTailNodes,
  TAIL_FRAMES,
  TAIL_TOKENS,
  tailFileFor,
} from "./latent-tail";
import { rewriteModelParam, rewriteNode } from "./rewrite-model";
import { isSet, type ParamDef, type ParamTarget, type ParamValue, type WorkflowDef } from "./types";
import {
  directorBypassFor,
  directorTarget,
  FRAME_EXPRESSION,
  frameCountFor,
  durationParam,
  EXTEND_DIRECTOR,
  h3Patches,
  h3ContentLora,
  h3StepSampler,
  h3Turbo,
  literalPromptParam,
  promptParam,
  samplingParams,
  type MinimaxNodeIds,
} from "./minimax-common";

/**
 * MiniMax H3 extend: keep a clip running past where it stopped.
 *
 * Structurally this is the image-to-video graph with the end of the clip
 * standing in for an upload, plus a join on the way out. Three parts:
 *
 * 1. **The seam.** It is built one of two ways, and `finalize` picks per run.
 *
 *    - **From the latents**, when the clip is a generation from this app and
 *      the hand-off brought its latent tail along (latent-tail.ts). 141 and 142
 *      load the last 22 frames' worth of video and audio latents exactly as
 *      the previous run's sampler left them; 145 pads the video to the new
 *      segment's length with a denoise mask that keeps those 7 tokens fixed,
 *      and 148 freezes the audio the same way. So the new segment *starts
 *      with* the end of the old one, sound included, and is sampled onward from
 *      it — nothing decoded and re-encoded in between. That is what keeps the
 *      colour from drifting pass after pass and the voice from resetting at
 *      the join.
 *    - **From the last frame**, for anything else — an upload has pixels
 *      only. 128 takes the last frame of the clip (`start_index: -1`) and
 *      105:104 receives it as `first_frame`. This is how every extension
 *      worked before the tails existed.
 *
 *    Either way 126 loads the clip at 24 fps — frames on output 0, sound on
 *    output 2 — 120 measures the last frame for the output size, and 123 shows
 *    it to the prompt director.
 * 2. **The generation.** The 105:* nodes are the same sampler stack as the
 *    other generating graphs, and the same duration → frame-count expression.
 *    That duration times the *new segment only*, which is the one thing about
 *    this workflow that reliably surprises people: ask for 10 seconds on a
 *    12-second clip and 22 seconds come back.
 * 3. **The join.** 131 concatenates the source frames with the generated ones
 *    and 135 does the same to the two audio tracks, so 137/138 save the whole
 *    video rather than the addition on its own. That is what makes extending
 *    an extension work: the output is always a complete clip, so it can go
 *    straight back in through the Extend button. From the latents, the new
 *    segment's first 22 frames are the source's last 22 again, so 151 and 152
 *    drop them before the join.
 *
 * Which also means the file grows with each pass, and so does the time spent
 * decoding and re-encoding it — the sampling cost stays flat, since only the
 * new segment is ever generated.
 */
const ids: MinimaxNodeIds = {
  // Node 125, not the video node: what the user types is the *input* to the
  // rewrite stage, and 105:104.prompt is a link now, not a value.
  prompt: { node: "125", input: "value" },
  director: "123",
  duration: "105:111",
  noise: "105:15",
  scheduler: "105:9",
};

const VIDEO_NODE = "126";

/**
 * The rate the source is read at, and the rate the join is written at.
 *
 * One constant because the two must agree: this graph concatenates the source's
 * own frames with the generated ones and writes the result as a single video,
 * so a source read at another rate plays its half at the wrong speed inside the
 * finished file.
 */
const SOURCE_FPS = 24;

const graph: ComfyGraph = {
  // The clip, read at 24 fps.
  //
  // VHS's loader, forcing the rate, because this graph *joins* the source to
  // what it generates: 131 batches the source's frames ahead of the new ones
  // and 137 writes the pair out at 24 fps. A source at any other rate has its
  // own half of the finished video replayed at the wrong speed — a 30 fps clip
  // plays a quarter slow before the extension starts, inside one file, which
  // is worse than being uniformly wrong. Nothing noticed because the usual
  // source is a generation from this app, already at 24.
  //
  // It also reads the fragmented MP4 a browser's MediaRecorder writes, which
  // ComfyUI's own loader measures as a single frame. See minimax-h3-ref.ts.
  //
  // No `frame_load_cap`: an extension carries the whole source through to the
  // output. Outputs are 0 frames, 1 frame count, 2 audio.
  "126": {
    class_type: "VHS_LoadVideo",
    inputs: {
      video: "",
      force_rate: SOURCE_FPS,
      custom_width: 0,
      custom_height: 0,
      frame_load_cap: 0,
      skip_first_frames: 0,
      select_every_nth: 1,
    },
    _meta: { title: "Load Video" },
  },

  // The last frame of the clip, and the only frame anything downstream sees.
  //
  // `start_index: -1` with `num_frames: 1` is what picks it; the randomness and
  // distance widgets are carried from the export and do nothing at that index.
  "128": {
    class_type: "RandomImageFromBatch",
    inputs: {
      start_index: -1,
      end_index: -1,
      num_frames: 1,
      randomness: 0,
      min_distance: 0,
      max_distance: 0,
      seed: 0,
      input: ["126", 0],
    },
    _meta: { title: "Random Image From Batch" },
  },
  // Reading the frame rather than the clip: same numbers either way, and this
  // is the image the continuation is actually generated against.
  "120": {
    class_type: "GetImageSize",
    inputs: { image: ["128", 0] },
    _meta: { title: "Get Image Size" },
  },

  // The prompt-rewrite stage: 125 holds what the user typed and 123 turns it
  // into what node 105:104 reads, with the last frame in view.
  //
  // EXTEND_DIRECTOR is what makes this a continuation rather than a new scene
  // sharing an opening image — it reads the input as what happens next and
  // spends most of its instructions on not resetting at the seam. Which model
  // it runs on is the `rewrite_model` param below; the key lives on the
  // ComfyUI host.
  //
  // The `system_prompt` is overwritten per run by the duration param, which
  // appends the length of the segment being generated — not of the video that
  // comes out, since the source is concatenated on afterwards and never
  // reaches the model.
  "123": rewriteNode({
    prompt: ["125", 0],
    system: EXTEND_DIRECTOR,
    images: ["128", 0],
    title: "AI Gateway - Rewrite Prompt",
  }),
  "125": {
    class_type: "PrimitiveStringMultiline",
    inputs: { value: "" },
    _meta: { title: "Input Text (Prompt)" },
  },

  "105:11": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" },
    _meta: { title: "Load VAE" },
  },
  "105:24": {
    class_type: "VAELoader",
    inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" },
    _meta: { title: "Load VAE" },
  },
  "105:23": {
    class_type: "VAEDecodeAudio",
    inputs: { samples: ["105:14", 0], vae: ["105:24", 0] },
    _meta: { title: "VAE Decode Audio" },
  },
  "105:10": {
    class_type: "VAEDecode",
    inputs: { samples: ["105:14", 0], vae: ["105:11", 0] },
    _meta: { title: "VAE Decode" },
  },
  "105:17": {
    class_type: "KSamplerSelect",
    inputs: { sampler_name: "res_multistep" },
    _meta: { title: "KSamplerSelect" },
  },
  "105:9": {
    class_type: "BasicScheduler",
    inputs: {
      scheduler: "simple",
      steps: 20,
      denoise: 1,
      model: ["105:6", 0],
    },
    _meta: { title: "BasicScheduler" },
  },
  "105:14": {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["105:15", 0],
      guider: ["105:16", 0],
      sampler: ["105:17", 0],
      sigmas: ["105:9", 0],
      latent_image: ["105:104", 1],
    },
    _meta: { title: "SamplerCustomAdvanced" },
  },
  "105:16": {
    class_type: "BasicGuider",
    inputs: { model: ["105:6", 0], conditioning: ["105:104", 0] },
    _meta: { title: "Basic Guider" },
  },
  "105:6": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
      weight_dtype: "default",
    },
    _meta: { title: "Load Diffusion Model" },
  },
  "105:13": {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      type: "minimax",
      device: "default",
    },
    _meta: { title: "Load CLIP" },
  },
  "105:15": {
    class_type: "RandomNoise",
    inputs: { noise_seed: 689734481905865 },
    _meta: { title: "RandomNoise" },
  },
  "105:91": {
    class_type: "CreateVideo",
    inputs: {
      fps: 24,
      bit_depth: 8,
      images: ["105:10", 0],
      audio: ["105:23", 0],
    },
    _meta: { title: "Create Video" },
  },
  "105:104": {
    class_type: "MiniMaxH3ImageToVideo",
    inputs: {
      prompt: ["123", 0],
      width: ["120", 0],
      height: ["120", 1],
      length: ["105:107", 1],
      clip: ["105:13", 0],
      vae: ["105:11", 0],
      first_frame: ["128", 0],
    },
    _meta: { title: "MiniMax H3 Image to Video" },
  },
  "105:107": {
    class_type: "ComfyMathExpression",
    inputs: {
      expression: FRAME_EXPRESSION(24),
      "values.a": ["105:111", 0],
    },
    _meta: { title: "Math Expression" },
  },
  "105:111": {
    class_type: "PrimitiveFloat",
    inputs: { value: 5 },
    _meta: { title: "Float (duration)" },
  },

  // The latent seam — see the top of the file. Present in every stored graph,
  // and either wired in or deleted by `finalize`, so check:nodes and the
  // requirements see the classes it needs.
  //
  // The two tail files, by name. The `source_tail` param writes both.
  "141": {
    class_type: "LoadLatent",
    inputs: { latent: "" },
    _meta: { title: "Load Latent (video tail)" },
  },
  "142": {
    class_type: "LoadLatent",
    inputs: { latent: "" },
    _meta: { title: "Load Latent (audio tail)" },
  },
  // The segment is one 17-frame group longer than from a frame, because its
  // first 22 frames are the carried ones and get dropped at the join: 5 s of
  // added time is 124 + 17 = 141 frames generated, 119 of them new.
  "143": {
    class_type: "ComfyMathExpression",
    inputs: { expression: "a + 17", "values.a": ["105:107", 1] },
    _meta: { title: "Math Expression (frames with tail)" },
  },
  // KJ's mask node works in LTX's time units: at a nominal 8 fps it addresses
  // H3's tokens one to one, and an end time of T - 7/8 pads the 7 carried
  // tokens out to the T this frame count has. Tokens are 5 per 17 frames, plus
  // 2.
  "144": {
    class_type: "ComfyMathExpression",
    inputs: {
      expression: "((a - 5) // 17) * 5 + 2 - 0.875",
      "values.a": ["143", 1],
    },
    _meta: { title: "Math Expression (mask end)" },
  },
  // Generate from the token after the tail onward; the tail itself and nothing
  // else is held. The padding is all masked in.
  "145": {
    class_type: "LTXVAudioVideoMask",
    inputs: {
      video_latent: ["141", 0],
      video_fps: 8,
      video_start_time: (8 * (TAIL_TOKENS - 1) + 1) / 8,
      video_end_time: ["144", 0],
      audio_start_time: 0,
      audio_end_time: 0,
      max_length: "pad",
      existing_mask_mode: "add",
    },
    _meta: { title: "LTXV Audio Video Mask" },
  },
  // An empty AV latent of the new length, only for its audio stream's shape:
  // 150 lays the frozen audio tail over the start of it.
  "146": {
    class_type: "EmptyMiniMaxH3LatentAV",
    inputs: { width: ["120", 0], height: ["120", 1], length: ["143", 1] },
    _meta: { title: "Empty MiniMax H3 Latent AV" },
  },
  "147": {
    class_type: "LTXVSeparateAVLatent",
    inputs: { av_latent: ["146", 0] },
    _meta: { title: "Separate AV Latent" },
  },
  "148": {
    class_type: "LTXVFreezeLatent",
    inputs: { latent: ["142", 0] },
    _meta: { title: "LTXV Freeze Latent (audio tail)" },
  },
  "149": {
    class_type: "LTXVConcatAVLatent",
    inputs: { video_latent: ["145", 0], audio_latent: ["147", 1] },
    _meta: { title: "Concat AV Latent" },
  },
  // Concat onto an AV latent swaps its audio stream for this one and pads it
  // to length, the padding left to be generated.
  "150": {
    class_type: "LTXVConcatAVLatent",
    inputs: { video_latent: ["149", 0], audio_latent: ["148", 0] },
    _meta: { title: "Concat AV Latent (audio tail)" },
  },
  // The carried 22 frames and their sound, off the front of the new segment.
  // Both lengths run past the end on purpose and are clamped to it.
  "151": {
    class_type: "ImageFromBatch",
    inputs: { image: ["132", 0], batch_index: TAIL_FRAMES, length: 4096 },
    _meta: { title: "Image From Batch (after the tail)" },
  },
  "152": {
    class_type: "TrimAudioDuration",
    inputs: {
      audio: ["132", 1],
      start_index: TAIL_FRAMES / SOURCE_FPS,
      duration: 3600,
    },
    _meta: { title: "Trim Audio Duration (after the tail)" },
  },

  // The join. 132 splits the generated segment back into frames and audio so
  // both can be appended to the source's own — pictures in 131, sound in 135 —
  // and 137 re-encodes the pair as one video at the same 24fps.
  "132": {
    class_type: "GetVideoComponents",
    inputs: { video: ["105:91", 0] },
    _meta: { title: "Get Video Components" },
  },
  "131": {
    class_type: "BatchImagesNode",
    inputs: {
      "images.image0": ["126", 0],
      "images.image1": ["132", 0],
    },
    _meta: { title: "Batch Images" },
  },
  "135": {
    class_type: "AudioConcatenate",
    inputs: {
      direction: "right",
      audio1: ["126", 2],
      audio2: ["132", 1],
    },
    _meta: { title: "AudioConcatenate" },
  },
  "137": {
    class_type: "CreateVideo",
    inputs: {
      fps: 24,
      bit_depth: 8,
      images: ["131", 0],
      audio: ["135", 0],
    },
    _meta: { title: "Create Video" },
  },
  "138": {
    class_type: "SaveVideo",
    inputs: {
      filename_prefix: "video/minimax_extend",
      format: "auto",
      codec: "auto",
      "video-preview": "",
      video: ["137", 0],
    },
    _meta: { title: "Save Video" },
  },

  // The song, continued. When the clip was made with its track locked in, the
  // next stretch of the same song is locked under the new segment the same way
  // — encoded, frozen, and swapped in for the audio the sampler would
  // otherwise generate — and the join takes the song itself for the new part.
  // See SONG_PARAM. Deleted by `finalize` on every other run.
  "160": {
    class_type: "LoadAudio",
    inputs: { audio: "" },
    _meta: { title: "Load Audio (song)" },
  },
  // The window under the whole new segment, carried frames included: on the
  // latent seam those are the source's last 22 frames, whose sound is the same
  // stretch of song the source already ends on.
  "161": {
    class_type: "TrimAudioDuration",
    inputs: { audio: ["160", 0], start_index: 0, duration: 5 },
    _meta: { title: "Trim Audio Duration (song under the segment)" },
  },
  "162": {
    class_type: "VAEEncodeAudio",
    inputs: { audio: ["161", 0], vae: ["105:24", 0] },
    _meta: { title: "VAE Encode Audio (song)" },
  },
  "163": {
    class_type: "LTXVFreezeLatent",
    inputs: { latent: ["162", 0] },
    _meta: { title: "LTXV Freeze Latent (song)" },
  },
  // From a frame there is no seam latent to carry the song in, so it goes in
  // over the image-to-video node's own.
  "164": {
    class_type: "LTXVConcatAVLatent",
    inputs: { video_latent: ["105:104", 1], audio_latent: ["163", 0] },
    _meta: { title: "Concat AV Latent (song)" },
  },
  // What the join appends: the song itself from where the source ends, rather
  // than a decode of it.
  "165": {
    class_type: "TrimAudioDuration",
    inputs: { audio: ["160", 0], start_index: 0, duration: 5 },
    _meta: { title: "Trim Audio Duration (song for the join)" },
  },

  // This run's own tail, so the extension can itself be extended the same way.
  ...latentTailNodes("105:14"),
};

/** The nodes only the song uses, deleted when it is not being continued. */
const SONG_NODES = ["160", "161", "162", "163", "164", "165"];

/**
 * The song a locked Reference to Video run was made to, carried by the hand-off
 * under the same ids that workflow uses, so an extension knows which song and
 * where in it the clip began. See `clipTarget.carry`.
 *
 * The lock is carried with them rather than assumed from there being a song:
 * a track used only as a reference is not one the source's sound is, and
 * continuing it would lay music under a clip that never had any.
 */
const SONG_PARAM = "reference_audio";
const SONG_START_PARAM = "reference_trim_start";
const SONG_LOCK_PARAM = "reference_track_lock";
const SOURCE_LENGTH_PARAM = "source_length";

/** Whether this run continues a locked song. */
const continuesSong = (values: Record<string, ParamValue>): boolean =>
  isSet(values[SONG_LOCK_PARAM]) && String(values[SONG_PARAM] ?? "").trim() !== "";

/** Whether the run takes the latent seam rather than the last frame. */
const takesSeam = (values: Record<string, ParamValue>): boolean => {
  const source = String(values.source_video ?? "");
  return source !== "" && String(values[TAIL_PARAM] ?? "") === source;
};

/**
 * Where in the song the new segment's window starts, and how long it runs.
 *
 * The clip began at the song's `reference_trim_start` — through every pass of
 * Extend, since each output is the whole clip from its first frame — and runs
 * for its measured length. On the seam the segment's first 22 frames are the
 * clip's last 22, so its window starts that much earlier.
 */
function songWindow(values: Record<string, ParamValue>): {
  start: number;
  seconds: number;
  carried: number;
} {
  const seam = takesSeam(values);
  const carried = seam ? TAIL_FRAMES / SOURCE_FPS : 0;
  const frames = frameCountFor(Number(values.duration ?? 5)) + (seam ? 17 : 0);
  const clipStart = Math.max(0, Number(values[SONG_START_PARAM] ?? 0));
  const clipLength = Math.max(0, Number(values[SOURCE_LENGTH_PARAM] ?? 0));
  return {
    start: clipStart + clipLength - carried,
    seconds: frames / SOURCE_FPS,
    carried,
  };
}

/** The nodes only the latent seam uses, deleted when it is not taken. */
const LATENT_SEAM = [
  "141",
  "142",
  "143",
  "144",
  "145",
  "146",
  "147",
  "148",
  "149",
  "150",
  "151",
  "152",
];

const TAIL_PARAM = "source_tail";

/**
 * What the clip already showed: the prompt that made it and every Extend line
 * since, oldest first, filled in by the hand-off. See `storyBlock`.
 */
const STORY_PARAM = "source_story";

/**
 * The story so far, for the director to read as background.
 *
 * Told as history it must not replay, never as the instruction: a segment given
 * the whole prompt again restarts it. Without it the director knows the clip
 * only from its last frame and re-describes the people in it from that alone,
 * and the description, the grade and the camera drift a little further with
 * each pass. With it they hold.
 *
 * Only for the clip it was written about — the one the tail names, which an
 * upload over the source slot no longer is.
 */
function storyBlock(values: Record<string, ParamValue>): string {
  const story = String(values[STORY_PARAM] ?? "").trim();
  const source = String(values.source_video ?? "");
  if (!story || !source || values[TAIL_PARAM] !== source) return "";
  return `WHAT THE CLIP ALREADY SHOWED

The source video was made from these instructions, oldest first. They are background only: use them for who these people are, what they wear, where this is, and how the clip looks and is shot. Do not repeat, replay or summarise any of it — the continuation describes only what happens next.

${story}`;
}

/**
 * Takes the latent seam when the loaded clip has a tail, and the last-frame one
 * otherwise. See the top of the file.
 *
 * A tail counts only when it is named after the clip in the source slot: the
 * hand-off writes the clip's reference into both, and an upload over it
 * afterwards changes only the one. Gluing another clip's ending onto this one
 * would start the extension on frames that are not there.
 */
function finalize(graph: ComfyGraph, values: Record<string, ParamValue>) {
  const seam = takesSeam(values);

  if (!seam) {
    for (const id of LATENT_SEAM) delete graph[id];
  } else {
    const i2v = graph["105:104"].inputs;
    delete i2v.first_frame;
    i2v.length = ["143", 1];
    graph["105:14"].inputs.latent_image = ["150", 0];
    graph["131"].inputs["images.image1"] = ["151", 0];
    graph["135"].inputs.audio2 = ["152", 0];
  }

  if (!continuesSong(values)) {
    for (const id of SONG_NODES) delete graph[id];
    return;
  }

  // A song with no measured clip length would be continued from the start of
  // the clip rather than its end, which is a different part of the song. The
  // browser measures the clip as it loads, so this only catches a submission
  // made before it had.
  if (!(Number(values[SOURCE_LENGTH_PARAM] ?? 0) > 0)) {
    throw new ParamError(
      "The clip's length has not been measured yet, so where the song carries on from is unknown. Wait for the clip to load and try again.",
      "source_video",
    );
  }

  // The song under the segment instead of the frozen tail or the generated
  // audio: on the seam it replaces the tail in the second concat — its first
  // 22 frames are the same stretch of song — and from a frame it goes in over
  // the image-to-video node's latent.
  if (seam) {
    graph["150"].inputs.audio_latent = ["163", 0];
    delete graph["148"];
    delete graph["164"];
  } else {
    graph["105:14"].inputs.latent_image = ["164", 0];
  }

  // The join appends the song from where the source's own sound ends, not a
  // decode of what the sampler was given.
  graph["135"].inputs.audio2 = ["165", 0];
  delete graph["152"];
}

/**
 * The single target every control that shapes the director's instructions
 * writes. Only the duration does here, but it is built the same way on every
 * graph so that adding a second contributor is a matter of passing this along
 * rather than of noticing that it needed to be.
 */
/**
 * The brief for a segment laid over the song, in this graph's three-field
 * format. The same facts as the reference graph's `lockedTrackBlock`: the
 * sound is settled, so the audio fields say so and the body is picture.
 */
function songBlock(values: Record<string, ParamValue>): string {
  if (!continuesSong(values)) return "";
  return `THE SONG CARRIES ON UNDER THIS SEGMENT

The clip was made to a song, and the next stretch of that same song has been laid into this segment as its finished audio, exactly as it is. The model generates the picture and no sound. Nothing you write can change it.

So write no sound: no dialogue, no lyrics, no sound effects and no ambience in the body. overall_soundscape is one sentence saying the soundtrack is the song carrying on from the clip, with nothing added. non_diegetic_music is one sentence saying the song continues throughout. Name no instrument, tempo or genre — you have not heard it.

If someone in the clip is performing the song, they carry on performing it, in sync with the vocal, without a reset at the seam: same delivery, same energy, moving with the music. You do not know when the vocal comes in or stops, so do not time it.`;
}

const director = directorTarget(ids, EXTEND_DIRECTOR, [storyBlock, songBlock]);

/** The two trims under the song, both written in full by every control that moves them. */
const songTargets: ParamTarget[] = [
  { node: "161", input: "start_index", transform: (_v, values) => songWindow(values).start },
  { node: "161", input: "duration", transform: (_v, values) => songWindow(values).seconds },
  {
    node: "165",
    input: "start_index",
    transform: (_v, values) => {
      const window = songWindow(values);
      return window.start + window.carried;
    },
  },
  {
    node: "165",
    input: "duration",
    transform: (_v, values) => {
      const window = songWindow(values);
      return window.seconds - window.carried;
    },
  },
];

const bypass = directorBypassFor(ids);

const params: ParamDef[] = [
  {
    id: "source_video",
    label: "Clip to continue",
    type: "video",
    default: "",
    required: true,
    help: "A clip made here carries on from its own latents; an upload, from its last frame. Up to 768×1344, 20s, 100 MB.",
    group: "Source",
    // How long it runs is where a continued song picks up. See songWindow.
    measures: SOURCE_LENGTH_PARAM,
    targets: [{ node: VIDEO_NODE, input: "video" }],
  },
  {
    id: SOURCE_LENGTH_PARAM,
    label: "Clip length",
    type: "measured",
    default: 0,
    group: "Source",
    targets: songTargets,
  },
  {
    id: SONG_LOCK_PARAM,
    label: "Continue the song",
    type: "toggle",
    default: false,
    help: "Lays the next stretch of the clip's song under the new footage, so a performance carries on in sync. Set by Extend on a clip made with its track as the soundtrack.",
    group: "Source",
    revealedBy: SONG_PARAM,
    targets: [director],
  },
  {
    id: SONG_PARAM,
    label: "Song",
    type: "audio",
    default: "",
    compact: true,
    help: "Optional. The song the clip was made to — Extend brings it over from a clip made with its track as the soundtrack.",
    group: "Source",
    targets: [{ node: "160", input: "audio" }],
  },
  {
    id: SONG_START_PARAM,
    label: "Song position at the clip's start",
    type: "number",
    default: 0,
    min: 0,
    max: 3600,
    step: 0.01,
    unit: "sec",
    help: "Where in the song the clip's first frame falls. Carried over by Extend; the new footage picks up where the clip ends.",
    group: "Source",
    advanced: true,
    revealedBy: [SONG_PARAM, SONG_LOCK_PARAM],
    targets: songTargets,
  },
  {
    id: TAIL_PARAM,
    label: "Latent tail",
    type: "carried",
    default: "",
    group: "Source",
    targets: [
      { node: "141", input: "latent", transform: (v) => tailFileFor(String(v), "video") },
      { node: "142", input: "latent", transform: (v) => tailFileFor(String(v), "audio") },
    ],
  },

  promptParam(
    ids,
    "He turns to her and says we need to leave.",
    "Say what happens next, not what the clip already showed. It can see the last frame and the story so far.",
    6,
  ),
  {
    id: STORY_PARAM,
    label: "Story so far",
    type: "textarea",
    default: "",
    maxLength: 4000,
    rows: 4,
    help: "What the clip already showed, filled in by Extend. The rewrite reads it as background and won't replay it.",
    group: "Source",
    revealedBy: TAIL_PARAM,
    targets: [director],
  },
  literalPromptParam(),
  rewriteModelParam(graph, [ids.director]),

  // Times the addition, not the result — the source's own length is whatever it
  // already was, and the two are concatenated afterwards. Worth saying on the
  // control itself, because every other workflow's duration is the duration of
  // the file that comes back.
  ((param) => ({ ...param, targets: [...param.targets, ...songTargets] }))(
    durationParam(ids, director, {
      label: "Added time",
      help: "How much new footage to generate. The result is the source clip plus this.",
      default: 5,
    }),
  ),

  ...samplingParams(ids),
];

export const minimaxH3Extend: WorkflowDef = {
  id: "minimax-h3-extend",
  name: "Extend",
  description: "Carries on from where a clip you already have left off.",
  estimatedSeconds: 300,
  hasAudio: true,
  graph,
  // A control that only ever wrote the director's instructions goes out of
  // the form with it. See hideDirectorOnly.
  params: hideDirectorOnly(params, bypass),
  directorBypass: bypass,
  turbo: h3Turbo(220),
  // The content LoRA first, matching the order they stack in: it is a LoRA on
  // the model, and the other two wrap whatever weights are in play by then.
  // Only the fl2va graphs offer it — see h3ContentLora, and the ref2va bases
  // its LoRAs are not made for.
  patches: [h3ContentLora(), ...h3Patches()],
  stepSampler: h3StepSampler(),
  /**
   * No `carry`, unlike Remix. The prompt that made the source describes the
   * source, and this graph reads what you type as what happens *next* — so
   * carrying it into the prompt box would ask the director to continue the clip
   * by doing again what it just did. It travels as the story instead, which
   * the director is told is history.
   */
  clipTarget: {
    action: "extend",
    accepts: "video",
    sourceParam: "source_video",
    carriedParam: TAIL_PARAM,
    storyParam: STORY_PARAM,
    // The song a locked clip was made to, where in it the clip began, and
    // whether it was locked — under the reference graph's own ids, so they
    // come across from it and from an earlier pass of this one alike.
    carry: [SONG_PARAM, SONG_START_PARAM, SONG_LOCK_PARAM],
  },
  finalize,
  finalizeCases: [
    {
      name: "a generation with its latent tail",
      values: {
        source_video: "clip.mp4",
        [TAIL_PARAM]: "clip.mp4",
        [STORY_PARAM]: "She walks along the pier.",
      },
    },
    { name: "an upload, no tail", values: { source_video: "clip.mp4" } },
    {
      name: "a tail left over from another clip",
      values: { source_video: "upload.mp4", [TAIL_PARAM]: "clip.mp4" },
    },
    {
      name: "a locked song continued on the seam",
      values: {
        source_video: "clip.mp4",
        [TAIL_PARAM]: "clip.mp4",
        [SOURCE_LENGTH_PARAM]: 8,
        [SONG_PARAM]: "song.mp3",
        [SONG_START_PARAM]: 10,
        [SONG_LOCK_PARAM]: true,
      },
    },
    {
      name: "a locked song continued from an upload's last frame",
      values: {
        source_video: "clip.mp4",
        [SOURCE_LENGTH_PARAM]: 8,
        [SONG_PARAM]: "song.mp3",
        [SONG_LOCK_PARAM]: true,
      },
    },
    {
      name: "a song carried over without the lock",
      values: {
        source_video: "clip.mp4",
        [TAIL_PARAM]: "clip.mp4",
        [SONG_PARAM]: "song.mp3",
        [SONG_LOCK_PARAM]: false,
      },
    },
    {
      name: "a locked song before the clip was measured",
      values: {
        source_video: "clip.mp4",
        [SONG_PARAM]: "song.mp3",
        [SONG_LOCK_PARAM]: true,
      },
      rejects: "has not been measured yet",
    },
    {
      name: "a generation with its latent tail, turbo",
      values: { source_video: "clip.mp4", [TAIL_PARAM]: "clip.mp4" },
      mode: { turbo: true },
    },
  ],
};
