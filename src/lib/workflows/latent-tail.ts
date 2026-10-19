import type { ComfyGraph } from "@/lib/comfy";

/**
 * The end of a generation, kept as the sampler left it, so Extend can carry on
 * from the latents instead of from a decoded frame.
 *
 * Why it matters: an extension that starts from the last *frame* has been
 * through a VAE decode, an MP4 encode, a decode and a VAE encode before the
 * model sees it again, and each pass adds a little contrast, a red cast, a held
 * frame at the join. Measured on the box (2026-10-19, three passes each): the
 * frame method's contrast climbed 79 → 91 and every join stalled, while
 * freezing the previous run's last latent tokens kept the colour flat, joined
 * without a jump, and carried the voice across. That test is what this file
 * implements.
 *
 * Two halves:
 *
 * 1. **Saving.** Every H3 graph that makes a video also writes the last
 *    {@link TAIL_TOKENS} video tokens and {@link TAIL_AUDIO} audio-latent frames
 *    of its sampler output — about 2 MB, through ComfyUI's own SaveLatent. The
 *    two save nodes have fixed ids so the hand-off can find them in the run's
 *    history: {@link TAIL_SAVE_VIDEO} and {@link TAIL_SAVE_AUDIO}.
 * 2. **Loading.** The Extend hand-off copies both files into ComfyUI's input
 *    directory beside the clip, named after it — see {@link tailFileFor} — and
 *    minimax-h3-extend.ts freezes them at the start of the new segment under a
 *    denoise mask.
 *
 * A clip with no tail — an upload, a run from before this existed, an upscale —
 * extends the old way, from its last frame.
 */

/**
 * Video tokens carried: 7, which is 22 frames, 0.92 s.
 *
 * Not free to change. H3's video tokens hold 1, 4, 4, 4, 4 frames in a
 * repeating group of five, so a cut has to start on the first token of a group
 * or the frozen tokens decode as the wrong frames. Every H3 latent is 5k + 2
 * tokens long, so the last 7 always start on a group boundary: 1+4+4+4+4 and
 * then 1+4.
 */
export const TAIL_TOKENS = 7;
/** Frames those tokens decode to. */
export const TAIL_FRAMES = 22;
/**
 * Audio-latent frames carried, at H3's 40 per second: 0.925 s, the nearest to
 * the video's 0.917. H3's audio latent is [batch, 32, 2, time], so the cut is
 * along the last dimension — which LatentCut calls "x".
 */
export const TAIL_AUDIO = 37;

export const TAIL_SAVE_VIDEO = "tail:save_video";
export const TAIL_SAVE_AUDIO = "tail:save_audio";

/** Which half of the tail a file holds. */
export type TailPart = "video" | "audio";

/**
 * Where the hand-off puts each half, named after the clip it belongs to — so a
 * tail can only ever be read alongside the clip it came from. Extend checks the
 * pairing before it uses one; see `finalize` there.
 */
export function tailFileFor(clipRef: string, part: TailPart): string {
  return `${clipRef}.${part}.latent`;
}

/**
 * The nodes that save a run's tail, reading the sampler's output.
 *
 * Spread into a graph beside its decode. They hang off the same output the
 * VAEDecode reads, so they cost a cut and a small write, never a second decode.
 */
export function latentTailNodes(sampler: string): ComfyGraph {
  return {
    "tail:split": {
      class_type: "LTXVSeparateAVLatent",
      inputs: { av_latent: [sampler, 0] },
      _meta: { title: "Separate AV Latent (tail)" },
    },
    "tail:video": {
      class_type: "LatentCut",
      inputs: {
        samples: ["tail:split", 0],
        dim: "t",
        index: -TAIL_TOKENS,
        amount: TAIL_TOKENS,
      },
      _meta: { title: "Latent Cut (video tail)" },
    },
    "tail:audio": {
      class_type: "LatentCut",
      inputs: {
        samples: ["tail:split", 1],
        dim: "x",
        index: -TAIL_AUDIO,
        amount: TAIL_AUDIO,
      },
      _meta: { title: "Latent Cut (audio tail)" },
    },
    [TAIL_SAVE_VIDEO]: {
      class_type: "SaveLatent",
      inputs: {
        samples: ["tail:video", 0],
        filename_prefix: "latents/h3_tail_video",
      },
      _meta: { title: "Save Latent (video tail)" },
    },
    [TAIL_SAVE_AUDIO]: {
      class_type: "SaveLatent",
      inputs: {
        samples: ["tail:audio", 0],
        filename_prefix: "latents/h3_tail_audio",
      },
      _meta: { title: "Save Latent (audio tail)" },
    },
  };
}
