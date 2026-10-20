"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobsController } from "@/hooks/use-jobs";
import { getToken } from "@/lib/client";
import type { Job } from "@/lib/jobs";
import { analyseSong } from "@/lib/music-video/beats";
import {
  parsePlan,
  planRequest,
  sceneValues,
  type MusicVideoProject,
  type ProjectScene,
} from "@/lib/music-video/project";
import { keptFrames, splitSong } from "@/lib/music-video/scenes";
import { FPS } from "@/lib/workflows/minimax-common";
import type { RunModes } from "@/lib/workflows/modes";
import type { ParamValue, WorkflowSummary } from "@/lib/workflows/types";

/**
 * The music video, from a song in the form to a finished file.
 *
 * Four steps, each waiting on the one before: cut the song (here, in the
 * browser), plan the scenes (a run of the plan graph), render them (one
 * Reference to Video job each, all queued at once — they do not depend on each
 * other), and join them (a run of the stitch graph). The scenes, the plan and
 * the stitch are jobs
 * like any other, so their progress, their history entries and the box's queue
 * are the job list's business; this only remembers which jobs belong to which
 * scene, and moves the project along as they finish.
 *
 * One project at a time, kept in localStorage so a reload part-way through a
 * long render finds it again. Starting a new plan replaces it — the old scenes
 * stay in the history.
 */

const STORAGE_KEY = "sorant-music-video";

export type MusicVideoStep =
  | "idle"
  | "cutting"
  | "planning"
  | "planned"
  | "rendering"
  | "rendered"
  | "stitching"
  | "done";

export interface MusicVideoController {
  project: MusicVideoProject | null;
  step: MusicVideoStep;
  error: string | null;
  /** Each scene's job, where it has one. */
  jobFor: (scene: ProjectScene) => Job | undefined;
  /** Cut the song and ask for a plan. */
  plan: () => Promise<void>;
  editShot: (index: number, shot: string) => void;
  /** Queue every scene that has no job, or whose job failed. */
  renderAll: () => Promise<void>;
  /** The finished video, once the stitch has run. */
  final: Job | undefined;
  /** Throw a scene's take away and render it again, on a fresh seed. */
  redo: (index: number) => Promise<void>;
  stitch: () => Promise<void>;
  clear: () => void;
  dismissError: () => void;
}

interface Options {
  workflow: WorkflowSummary | undefined;
  sceneWorkflow: WorkflowSummary | undefined;
  stitchWorkflow: WorkflowSummary | undefined;
  values: Record<string, ParamValue>;
  modes: RunModes & { lowVram?: boolean; localDirector?: string };
  jobs: JobsController;
}

function readProject(): MusicVideoProject | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as MusicVideoProject) : null;
  } catch {
    return null;
  }
}

function writeProject(project: MusicVideoProject | null): void {
  try {
    if (project) localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage full or disabled: the project lives for this tab only.
  }
}

/** The gateway's own "try again" answers, as the director node reports them. */
const TRANSIENT = /AI Gateway request failed \(HTTP (429|5\d\d)\)/;
const MAX_RETRIES = 2;

const failed = (job: Job | undefined) =>
  job !== undefined && ["error", "cancelled", "unknown"].includes(job.phase);

export function useMusicVideo({
  workflow,
  sceneWorkflow,
  stitchWorkflow,
  values,
  modes,
  jobs,
}: Options): MusicVideoController {
  const [project, setProject] = useState<MusicVideoProject | null>(readProject);
  const [busy, setBusy] = useState<"cutting" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => writeProject(project), [project]);

  const byId = useMemo(
    () => new Map(jobs.jobs.map((job) => [job.promptId, job])),
    [jobs.jobs],
  );
  const jobFor = useCallback(
    (scene: ProjectScene) => (scene.promptId ? byId.get(scene.promptId) : undefined),
    [byId],
  );

  // The plan arriving. Read off the plan job's brief, which is the planner's
  // reply, and folded into the scenes — once, since every edit after that is
  // the user's.
  const planJob = project?.planPromptId ? byId.get(project.planPromptId) : undefined;
  useEffect(() => {
    if (!project || !planJob || project.scenes.some((scene) => scene.shot)) return;
    if (planJob.phase === "done") {
      const reply = Object.values(planJob.briefs ?? {})[0] ?? "";
      const shots = parsePlan(reply, project.scenes.length);
      setProject({
        ...project,
        scenes: project.scenes.map((scene, index) => ({ ...scene, shot: shots[index] })),
      });
      // The plan is a step, not a result: it has no file, and a history entry
      // that never shows anything is clutter.
      jobs.remove(planJob.promptId);
    } else if (failed(planJob)) {
      setError(planJob.error ?? "The plan did not come back. Try again.");
      setProject({ ...project, planPromptId: undefined });
    }
  }, [project, planJob, jobs]);

  const stitchJob = project?.stitchPromptId ? byId.get(project.stitchPromptId) : undefined;
  const final = stitchJob?.phase === "done" ? stitchJob : undefined;

  const step: MusicVideoStep = useMemo(() => {
    if (busy) return busy;
    if (!project) return "idle";
    if (final) return "done";
    if (stitchJob && !failed(stitchJob)) return "stitching";
    if (!project.scenes.some((scene) => scene.shot)) {
      return project.planPromptId ? "planning" : "idle";
    }
    const sceneJobs = project.scenes.map(jobFor);
    if (sceneJobs.every((job) => job?.phase === "done")) return "rendered";
    if (sceneJobs.some((job) => job && !failed(job))) return "rendering";
    return "planned";
  }, [busy, project, jobFor, final, stitchJob]);

  // A stitch that failed says so and lets the button be pressed again.
  useEffect(() => {
    if (!project || !stitchJob || !failed(stitchJob)) return;
    setError(stitchJob.error ?? "The scenes could not be joined.");
    setProject({ ...project, stitchPromptId: undefined });
  }, [project, stitchJob]);

  const plan = useCallback(async () => {
    if (!workflow) return;
    setError(null);
    const song = String(values.reference_audio ?? "").trim();
    if (!song) {
      setError("Add the song first.");
      return;
    }

    setBusy("cutting");
    try {
      // The song from ComfyUI's input directory, where the upload put it.
      const query = new URLSearchParams({ filename: song, subfolder: "", type: "input" });
      const headers = new Headers();
      const token = getToken();
      if (token) headers.set("x-app-token", token);
      const response = await fetch(`/api/media?${query}`, { headers });
      if (!response.ok) throw new Error("Could not load the song to cut it.");
      const analysis = await analyseSong(await response.arrayBuffer());

      const windows = splitSong(
        analysis.seconds,
        analysis.onsets,
        {
          min: Number(values.scene_min_seconds ?? 4),
          max: Number(values.scene_max_seconds ?? 9),
        },
        analysis.loudness,
      );

      const next: MusicVideoProject = {
        id: Date.now().toString(36),
        createdAt: Date.now(),
        song,
        songSeconds: analysis.seconds,
        values: { ...values },
        scenes: windows.map((window) => ({ ...window, shot: "" })),
      };

      const promptId = await jobs.submit(
        workflow,
        { ...values, prompt: planRequest(String(values.prompt ?? ""), windows) },
        { localDirector: modes.localDirector },
      );
      if (!promptId) return;
      setProject({ ...next, planPromptId: promptId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cut the song.");
    } finally {
      setBusy(null);
    }
  }, [workflow, values, jobs, modes.localDirector]);

  const editShot = useCallback((index: number, shot: string) => {
    setProject((previous) =>
      previous
        ? {
            ...previous,
            scenes: previous.scenes.map((scene, i) => (i === index ? { ...scene, shot } : scene)),
          }
        : previous,
    );
  }, []);

  /** Which form ids every scene run inherits — the ones scoped to scenes. */
  const scoped = useMemo(
    () => (workflow?.params ?? []).filter((param) => param.scope === "scenes").map((param) => param.id),
    [workflow],
  );

  const submitScene = useCallback(
    async (current: MusicVideoProject, index: number, fresh: boolean) => {
      if (!sceneWorkflow) return null;
      const scene = current.scenes[index];
      const values = sceneValues(current, scene, index, scoped);
      if (fresh) values.seed = -1;
      // Under the first scene in the history, so a video's scenes read as one
      // family rather than forty unrelated clips.
      const first = current.scenes[0]?.promptId;
      return jobs.submit(sceneWorkflow, values, {
        ...modes,
        derivedFrom: index > 0 ? first : undefined,
      });
    },
    [sceneWorkflow, scoped, jobs, modes],
  );

  /**
   * A scene whose brief never got written because the gateway was briefly
   * unavailable is put straight back in the queue, twice at most.
   *
   * Over a song's worth of scenes the rewrite is called a dozen times or more,
   * and a 503 on one of them — seen on the first full test, four scenes in a
   * row — would otherwise leave a hole for someone to notice and fill. Only
   * the gateway's own transient answers count: anything else that fails a
   * scene is worth a person looking at.
   */
  const retrying = useRef(new Set<string>());
  useEffect(() => {
    if (!project || !sceneWorkflow) return;
    project.scenes.forEach((scene, index) => {
      const job = jobFor(scene);
      if (!job || job.phase !== "error" || !TRANSIENT.test(job.error ?? "")) return;
      if ((scene.retries ?? 0) >= MAX_RETRIES || retrying.current.has(job.promptId)) return;
      retrying.current.add(job.promptId);
      void submitScene(project, index, false).then((promptId) => {
        if (!promptId) return;
        setProject((previous) =>
          previous
            ? {
                ...previous,
                scenes: previous.scenes.map((s, i) =>
                  i === index ? { ...s, promptId, retries: (s.retries ?? 0) + 1 } : s,
                ),
              }
            : previous,
        );
      });
    });
  }, [project, sceneWorkflow, jobFor, submitScene]);

  const renderAll = useCallback(async () => {
    if (!project) return;
    setError(null);
    // One at a time, so the queue receives them in song order and each id is
    // recorded as it arrives — a refusal part-way leaves the rest unsubmitted
    // rather than half-tracked.
    let current = project;
    for (let index = 0; index < current.scenes.length; index += 1) {
      const scene = current.scenes[index];
      const job = jobFor(scene);
      if (scene.promptId && !failed(job)) continue;
      const promptId = await submitScene(current, index, failed(job));
      if (!promptId) {
        setError(`Scene ${index + 1} was refused — see the message above.`);
        break;
      }
      current = {
        ...current,
        scenes: current.scenes.map((s, i) => (i === index ? { ...s, promptId } : s)),
      };
      setProject(current);
    }
  }, [project, jobFor, submitScene]);

  const redo = useCallback(
    async (index: number) => {
      if (!project) return;
      const old = jobFor(project.scenes[index]);
      if (old && (old.phase === "queued" || old.phase === "running")) {
        await jobs.cancel(old.promptId);
      }
      const promptId = await submitScene(project, index, true);
      if (!promptId) return;
      setProject((previous) =>
        previous
          ? {
              ...previous,
              stitchPromptId: undefined,
              scenes: previous.scenes.map((s, i) => (i === index ? { ...s, promptId } : s)),
            }
          : previous,
      );
    },
    [project, jobFor, jobs, submitScene],
  );

  const stitch = useCallback(async () => {
    if (!project || !stitchWorkflow) return;
    setError(null);
    const clips = project.scenes.map((scene) => {
      const output = jobFor(scene)?.outputs.find((file) => /\.(mp4|webm|mov)$/i.test(file.filename));
      if (!output) return null;
      // As LoadVideo names a file in another of ComfyUI's folders.
      const path = output.subfolder ? `${output.subfolder}/${output.filename}` : output.filename;
      return { file: `${path} [${output.type || "output"}]`, seconds: keptFrames(scene) / FPS };
    });
    if (clips.some((clip) => clip === null)) {
      setError("Every scene needs a finished clip before they can be joined.");
      return;
    }

    const promptId = await jobs.submit(
      stitchWorkflow,
      {
        scenes: JSON.stringify(clips),
        song: project.song,
        song_seconds: Math.round(project.songSeconds * 1000) / 1000,
        prompt: `Music video: ${String(project.values.prompt ?? "").trim()}`,
      },
      // Under the first scene in the history, with the rest of the video.
      { derivedFrom: project.scenes[0]?.promptId },
    );
    if (promptId) setProject({ ...project, stitchPromptId: promptId });
  }, [project, stitchWorkflow, jobFor, jobs]);

  const clear = useCallback(() => {
    setProject(null);
    setError(null);
  }, []);

  return {
    project,
    step,
    error,
    jobFor,
    plan,
    editShot,
    renderAll,
    redo,
    final,
    stitch,
    clear,
    dismissError: useCallback(() => setError(null), []),
  };
}
