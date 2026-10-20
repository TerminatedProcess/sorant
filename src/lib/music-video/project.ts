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
  /** The run that joins the scenes, once every one of them has a clip. */
  stitchPromptId?: string;
  /** Set once someone asks for the upscaled video; the join of it follows. */
  upscaleRequested?: boolean;
  /** The run that joins the upscaled scenes. */
  upscaledStitchPromptId?: string;
}

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
export function parsePlan(reply: string, count: number): string[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  let shots: string[] = [];
  if (start !== -1 && end > start) {
    const body = reply.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
    try {
      const parsed = JSON.parse(body) as { scenes?: Array<{ shot?: unknown } | string> };
      shots = (parsed.scenes ?? []).map((scene) =>
        typeof scene === "string" ? scene : String(scene?.shot ?? ""),
      );
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
  return Array.from({ length: count }, (_, index) => (shots[index] ?? "").trim());
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
  return {
    ...values,
    reference_audio: project.song,
    reference_track_seconds: project.songSeconds,
    reference_track_lock: true,
    reference_trim: "match",
    reference_trim_start: scene.start,
    duration: renderSeconds(scene),
    prompt: idea
      ? `${scene.shot}\n\n(This is scene ${index + 1} of ${project.scenes.length} in a music video. The video as a whole: ${idea} — background only; this scene shows only what is described above.)`
      : scene.shot,
    // A fixed offset per scene from one base, so a whole video can be made
    // again exactly; a random base stays random per scene.
    seed: seed >= 0 ? seed + index : -1,
  };
}

/** Whether a scene is still to be (re)submitted. */
export const needsRender = (scene: ProjectScene): boolean => !scene.promptId;
