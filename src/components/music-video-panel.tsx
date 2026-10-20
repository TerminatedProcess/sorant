"use client";

import type { MusicVideoController } from "@/hooks/use-music-video";
import { withToken } from "@/lib/client";
import type { Job } from "@/lib/jobs";
import { clock } from "@/lib/music-video/scenes";
import { Badge, Dot, Panel, PanelHeader } from "./ui/panel";
import { Button, buttonClasses, Spinner } from "./ui/button";
import { TextArea } from "./ui/inputs";

/**
 * The music video's own stage: the scene list, each scene's take as it
 * arrives, and the finished video.
 *
 * Shown above the usual stage rather than in place of it. A scene is a job,
 * so the stage and the history below still show any one of them in full —
 * this is the view of all of them together.
 */

const STEP_HINT: Record<MusicVideoController["step"], string> = {
  idle: "Add the song and an idea, then plan the video.",
  cutting: "Cutting the song on its beats…",
  planning: "Writing a scene for every cut…",
  planned: "Read the scenes through and change any you like, then render them.",
  rendering: "Rendering — every scene is queued, and they run one after another.",
  rendered: "Every scene is done. Redo any you do not like, then join them.",
  stitching: "Joining the scenes and laying the song over them…",
  done: "Finished.",
};

export function MusicVideoPanel({ video }: { video: MusicVideoController }) {
  const { project, step } = video;
  // The saved file, not the previews of what it was made from: every scene's
  // loader and trim reports a video of its own in the same run.
  const finalUrl = video.final?.outputs.find(
    (file) => file.type === "output" && /^music_video.*\.(mp4|webm|mov)$/i.test(file.filename),
  )?.url;
  const scenes = project?.scenes ?? [];
  const jobs = scenes.map(video.jobFor);
  const finished = jobs.filter((job) => job?.phase === "done").length;
  const unrendered = scenes.filter((scene, index) => {
    const job = jobs[index];
    return !scene.promptId || (job && ["error", "cancelled", "unknown"].includes(job.phase));
  }).length;

  return (
    <Panel padded>
      <PanelHeader
        title="Music video"
        hint={STEP_HINT[step]}
        action={
          project ? (
            <Button
              variant="quiet"
              size="xs"
              onClick={video.clear}
              disabled={step === "cutting"}
              title="Forget this plan. Its scenes stay in the history."
            >
              Start over
            </Button>
          ) : null
        }
      />

      {video.error ? (
        <div
          className="mb-4 flex items-start gap-3 rounded-lg border border-danger/40
            bg-danger/5 p-3 text-[13px] leading-relaxed text-danger"
        >
          <span className="min-w-0 flex-1">{video.error}</span>
          <Button variant="danger" size="xs" className="shrink-0" onClick={video.dismissError}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {step === "cutting" || step === "planning" ? (
        <p className="flex items-center gap-2 text-[13px] text-fg-muted">
          <Spinner className="size-3.5" />
          {step === "cutting"
            ? "Finding the beats in the song."
            : `${scenes.length} scenes, ${clock(project?.songSeconds ?? 0)} of song.`}
        </p>
      ) : null}

      {finalUrl ? (
        <div className="mb-5">
          <video
            src={withToken(finalUrl)}
            controls
            playsInline
            className="w-full rounded-lg border border-border-default bg-black"
          />
          <div className="mt-2 flex gap-2">
            <a
              href={withToken(finalUrl)}
              download={`music_video_${project?.id ?? ""}.mp4`}
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Download
            </a>
          </div>
        </div>
      ) : null}

      {scenes.some((scene) => scene.shot) ? (
        <>
          <ol className="flex flex-col gap-3">
            {scenes.map((scene, index) => {
              const job = jobs[index];
              const clip = job?.outputs.find((file) => /\.(mp4|webm|mov)$/i.test(file.filename));
              return (
                <li
                  key={`${scene.start}-${index}`}
                  className="rounded-lg border border-border-default p-3"
                >
                  <div className="mb-2 flex items-center gap-2 text-[12px] text-fg-muted">
                    <span className="font-medium text-fg">Scene {index + 1}</span>
                    <span className="font-mono">
                      {clock(scene.start)}–{clock(scene.end)}
                    </span>
                    <span>{(scene.end - scene.start).toFixed(1)} s</span>
                    <SceneStatus job={job} />
                    {job && (job.phase === "done" || ["error", "cancelled", "unknown"].includes(job.phase)) ? (
                      <Button
                        variant="quiet"
                        size="xs"
                        className="ml-auto"
                        onClick={() => void video.redo(index)}
                        title="Render this scene again on a fresh seed, with the shot as it reads now"
                      >
                        Redo
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <div className="min-w-0 flex-1">
                      <TextArea
                        id={`scene-${index}`}
                        value={scene.shot}
                        rows={3}
                        maxLength={2000}
                        // Editable except while its take is in the queue: the
                        // run has already been handed what it said.
                        disabled={job?.phase === "queued" || job?.phase === "running"}
                        onChange={(value) => video.editShot(index, value)}
                      />
                    </div>
                    {clip ? (
                      <video
                        src={withToken(clip.url)}
                        muted
                        loop
                        playsInline
                        controls
                        preload="metadata"
                        className="w-full rounded-md border border-border-default bg-black sm:w-48"
                      />
                    ) : null}
                  </div>
                  {job?.phase === "error" && job.error ? (
                    <p className="mt-2 text-[12px] leading-relaxed text-danger">{job.error}</p>
                  ) : null}
                </li>
              );
            })}
          </ol>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {unrendered > 0 ? (
              <Button variant="primary" onClick={() => void video.renderAll()}>
                {finished > 0 || unrendered < scenes.length
                  ? `Render the ${unrendered} remaining`
                  : `Render ${scenes.length} scenes`}
              </Button>
            ) : null}
            {step === "rendered" || step === "done" ? (
              <Button
                variant={step === "done" ? "secondary" : "primary"}
                onClick={() => void video.stitch()}
              >
                Join into the video
              </Button>
            ) : null}
            {step === "stitching" ? (
              <span className="flex items-center gap-2 text-[13px] text-fg-muted">
                <Spinner className="size-3.5" /> Joining {scenes.length} scenes
              </span>
            ) : null}
            <span className="text-[12px] text-fg-subtle">
              {finished} of {scenes.length} scenes rendered
            </span>
          </div>
        </>
      ) : null}
    </Panel>
  );
}

function SceneStatus({ job }: { job: Job | undefined }) {
  if (!job) return <Badge>not rendered</Badge>;
  switch (job.phase) {
    case "queued":
      return (
        <Badge>
          <Dot /> queued{job.queuePosition ? ` · ${job.queuePosition} ahead` : ""}
        </Badge>
      );
    case "running":
      return (
        <Badge tone="accent">
          <Dot tone="accent" pulse /> rendering
        </Badge>
      );
    case "done":
      return <Badge tone="success">done</Badge>;
    case "cancelled":
      return <Badge tone="warning">cancelled</Badge>;
    default:
      return <Badge tone="danger">failed</Badge>;
  }
}
