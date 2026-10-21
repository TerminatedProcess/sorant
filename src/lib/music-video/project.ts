import { leadingReferences, referenceKeep } from "@/lib/workflows/minimax-common";
import type { ParamValue } from "@/lib/workflows/types";
import { clock, renderSeconds, SCENES_HEADING, type SceneWindow } from "./scenes";

/**
 * One music video in progress, as the browser keeps it.
 *
 * The scenes and the stitch are ordinary jobs — submitted, polled, kept in the
 * history and retried like any other run — so this holds only what ties them
 * together: where each scene sits in the song, what it was asked to show, and
 * which job made it. Kept in localStorage beside the jobs, so a reload in the
 * middle of a forty-scene render picks up where it was.
 */
export interface MusicVideoProject {
  id: string;
  createdAt: number;
  /** The song as ComfyUI's input directory names it. */
  song: string;
  songSeconds: number;
  /** The form values the plan was made from. Every scene run starts from them. */
  values: Record<string, ParamValue>;
  /** The planning run, while it is running and after. */
  planPromptId?: string;
  scenes: ProjectScene[];
  /**
   * How the referenced subjects look, fixed once for the whole video: the
   * planner's, until someone edits it. Empty without pictures, and absent on a
   * project planned before there was one. See `sceneValues`.
   */
  look?: string;
  /** The run that joins the scenes, once every one of them has a clip. */
  stitchPromptId?: string;
  /** Set once someone asks for the upscaled video; the join of it follows. */
  upscaleRequested?: boolean;
  /** The run that joins the upscaled scenes. */
  upscaledStitchPromptId?: string;
  /**
   * The shorter side the scenes are upscaled to. Fixed when the first one is
   * sent, so a scene upscaled later — a redo, or one that failed — comes out
   * the same size as the rest and the join has one size to work with.
   */
  upscaleSize?: number;
}

/**
 * The sizes a music video can be upscaled to, and roughly what each costs:
 * seconds of work per second of song on the 3090, from 15-second clips at
 * 800 px (1234 s) and 1080 px (2700 s). The first is the default — a song is
 * minutes long, and at 1080 a three-minute one is nine hours.
 */
export const MUSIC_VIDEO_UPSCALE_SIZES = [
  { px: 800, secondsPerSecond: 82 },
  { px: 1080, secondsPerSecond: 180 },
] as const;

export interface ProjectScene extends SceneWindow {
  /** What happens in it: the planner's, until someone edits it. */
  shot: string;
  /** The job that rendered it, if it has been submitted. */
  promptId?: string;
  /** How many times it has been put back after a transient gateway failure. */
  retries?: number;
  /** The job that upscaled its clip, if the video has been upscaled. */
  upscalePromptId?: string;
}

/**
 * The planner's input: the user's idea, then the scenes it has to fill.
 *
 * Written into the prompt rather than a param of its own, because it is the
 * prompt — the thing the planner reads — and building it here keeps the one
 * piece of the brief that depends on the song's analysis in the one place
 * that has the analysis.
 */
export function planRequest(idea: string, scenes: SceneWindow[]): string {
  const lines = scenes.map((scene, index) => {
    const seconds = (scene.end - scene.start).toFixed(1);
    return `${index + 1}. ${clock(scene.start)}–${clock(scene.end)} (${seconds} s), loudness ${describeEnergy(scene.energy)}`;
  });
  return `${idea.trim() || "A performance video for this song."}

${SCENES_HEADING}

The song is cut into ${scenes.length} scenes:

${lines.join("\n")}`;
}

function describeEnergy(energy: number): string {
  if (energy < 0.35) return "quiet";
  if (energy < 0.6) return "medium";
  if (energy < 0.8) return "loud";
  return "very loud";
}

/**
 * The scene list out of the planner's reply.
 *
 * Forgiving about everything but the count: a fence around the JSON, a
 * sentence before it, a trailing comma — all things a model does — are got
 * past. A reply with the wrong number of scenes is padded or cut rather than
 * refused, since every scene is editable before anything renders and an empty
 * one says plainly what is missing.
 */
export function parsePlan(
  reply: string,
  count: number,
): { look: string; shots: string[] } {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  let shots: string[] = [];
  let look = "";
  if (start !== -1 && end > start) {
    const body = reply.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
    try {
      const parsed = JSON.parse(body) as {
        look?: unknown;
        scenes?: Array<{ shot?: unknown } | string>;
      };
      shots = (parsed.scenes ?? []).map((scene) =>
        typeof scene === "string" ? scene : String(scene?.shot ?? ""),
      );
      look = typeof parsed.look === "string" ? parsed.look.trim() : "";
    } catch {
      shots = [];
    }
  }
  if (shots.length === 0) {
    // Not JSON at all: one scene per numbered line, if it numbered them.
    shots = reply
      .split("\n")
      .map((line) => line.match(/^\s*\d+[.)]\s*(.+)$/)?.[1] ?? "")
      .filter(Boolean);
  }
  return {
    look,
    shots: Array.from({ length: count }, (_, index) => (shots[index] ?? "").trim()),
  };
}

/**
 * One scene's Reference to Video submission.
 *
 * Starts from the form's own values — every one of them scoped to the scenes
 * shares its id with the scene workflow's control, so it lands on the right
 * one — and sets what is the scene's own: its stretch of the song, locked in;
 * its length; its shot; its seed.
 *
 * The prompt carries the whole video's idea as well as the scene, marked as
 * background, so each scene's director knows what it is a part of without
 * writing the whole video into one shot.
 *
 * And the look, word for word, ahead of that. Each scene's director describes
 * the people in the pictures for itself, and given the pictures and an idea
 * that described them differently, it settled the conflict a different way in
 * nearly every scene: of one video's 41, 23 dressed the singer as the idea
 * said, 6 as the picture showed, and 11 in both hats at once. One description
 * for all of them is what holds the costume across the cuts.
 */
export function sceneValues(
  project: MusicVideoProject,
  scene: ProjectScene,
  index: number,
  scoped: string[],
): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {};
  for (const id of scoped) {
    if (id in project.values) values[id] = project.values[id];
  }

  const seed = Number(project.values.seed ?? -1);
  const idea = String(project.values.prompt ?? "").trim();
  const look = project.look?.trim() ?? "";
  const lookNote = look
    ? `\n\n(How they look, in this scene and every other one in the video: ${look} — use these words as the observed detail in each subject's definition, and describe them no other way. They outrank anything below about anyone's appearance.)`
    : "";
  const shot = `${scene.shot}${lookNote}`;
  return {
    ...values,
    reference_audio: project.song,
    reference_track_seconds: project.songSeconds,
    reference_track_lock: true,
    reference_trim: "match",
    reference_trim_start: scene.start,
    duration: renderSeconds(scene),
    prompt: idea
      ? `${shot}\n\n(This is scene ${index + 1} of ${project.scenes.length} in a music video. The video as a whole: ${idea} — background only; this scene shows only what is described above${look ? ", and its people look only as described above" : ""}.)`
      : shot,
    // A fixed offset per scene from one base, so a whole video can be made
    // again exactly; a random base stays random per scene.
    seed: seed >= 0 ? seed + index : -1,
  };
}

/**
 * The look every scene is handed: what the describer saw in the pictures,
 * then what the planner chose for anything they release.
 *
 * The planner's half is used only when a picture does release something — is
 * set to keep the person and not their clothes, or the clothes and not the
 * person. Told to leave it empty otherwise, the local model wrote the user's
 * idea's outfit into it anyway, which handed the scenes the very conflict the
 * describer exists to keep out.
 */
export function composeLook(
  cast: string | undefined,
  planned: string,
  values: Record<string, ParamValue>,
  pictures: number,
): string {
  const filled = leadingReferences(values, pictures);
  let releases = false;
  for (let index = 1; index <= filled; index += 1) {
    const keep = referenceKeep(values, index);
    if (keep === "identity" || keep === "costume") releases = true;
  }
  return [cast?.trim(), releases ? planned.trim() : ""].filter(Boolean).join("\n\n");
}

/** Whether a scene is still to be (re)submitted. */
export const needsRender = (scene: ProjectScene): boolean => !scene.promptId;
