import { imageEdit } from "./image-edit";
import { minimaxH3 } from "./minimax-h3";
import { minimaxH3Extend } from "./minimax-h3-extend";
import { minimaxH3Image } from "./minimax-h3-image";
import { minimaxH3ImageToVideo } from "./minimax-h3-i2v";
import { minimaxH3Reference } from "./minimax-h3-ref";
import { minimaxH3ReferenceVideo } from "./minimax-h3-ref2v";
import { minimaxMusic3 } from "./minimax-music3";
import { musicVideo } from "./music-video";
import { musicVideoStitch } from "./music-video-stitch";
import { rtxUpscale } from "./rtx-upscale";
import { seedvr2Upscale } from "./seedvr2-upscale";
import { toSummary, type WorkflowDef, type WorkflowSummary } from "./types";

/**
 * The predetermined set of workflows the app offers. Add a new file next to
 * minimax-h3.ts and register it here — nothing else needs to change.
 *
 * A turbo variant is not a workflow. Every graph here declares `turbo` and the
 * LoRA is spliced in on the way to the queue, so the list stays one entry per
 * thing the app can do rather than two per thing times a sampling mode.
 */
export const WORKFLOWS: WorkflowDef[] = [
  minimaxH3,
  // The same graph stopped at its first frame. See the file for why.
  minimaxH3Image,
  minimaxH3ImageToVideo,
  minimaxH3Reference,
  minimaxH3ReferenceVideo,
  minimaxH3Extend,
  // Plans a whole song and runs Reference to Video once per scene. After the
  // graph it runs, which it names by id.
  musicVideo,
  // Not generators: each takes a finished clip, by the Upscale and Add detail
  // buttons.
  rtxUpscale,
  seedvr2Upscale,
  // Last, and the only one that is not H3 and not video: a different model
  // family that happens to fit the same shape of definition.
  minimaxMusic3,
  // Not in the picker: the Edit button on a picture runs it. See `tool`.
  imageEdit,
  // Not in the picker either: the music video's panel runs it to join scenes.
  musicVideoStitch,
];

export function getWorkflow(id: string): WorkflowDef | undefined {
  return WORKFLOWS.find((workflow) => workflow.id === id);
}

export function workflowSummaries(): WorkflowSummary[] {
  return WORKFLOWS.map(toSummary);
}

export type { WorkflowDef, WorkflowSummary };
