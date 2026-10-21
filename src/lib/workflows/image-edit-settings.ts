import type { ParamDef, ParamValue } from "./types";

/**
 * The Edit image controls someone may tune, kept apart from the graph so the
 * edit bar can render them: the graph is server-only, and the edit workflow is
 * a tool, so it never reaches the browser through /api/workflows.
 *
 * Node ids are the image-edit graph's. `pnpm check:workflows` holds every
 * target to that graph, so a renumbered node fails there rather than here.
 */

export const EDIT_GUIDANCE_NODE = "14";
export const EDIT_SAMPLER_NODE = "7";

export const IMAGE_EDIT_SETTINGS: ParamDef[] = [
  {
    id: "guidance",
    label: "Guidance",
    help: "Lower looks less contrasty and plastic; higher follows the change more strictly.",
    type: "slider",
    default: 2.5,
    min: 1,
    max: 5,
    step: 0.1,
    targets: [{ node: EDIT_GUIDANCE_NODE, input: "guidance" }],
  },
  {
    id: "steps",
    label: "Steps",
    help: "More steps keep finer texture such as skin and hair, and take about 2 s each.",
    type: "slider",
    default: 20,
    min: 4,
    max: 40,
    step: 1,
    targets: [{ node: EDIT_SAMPLER_NODE, input: "steps" }],
  },
  {
    id: "redraw",
    label: "Redraw",
    help: "Below 1 starts from the picture instead of noise: keeps its grain, colour and light, but allows smaller changes.",
    type: "slider",
    default: 1,
    min: 0.5,
    max: 1,
    step: 0.05,
    targets: [{ node: EDIT_SAMPLER_NODE, input: "denoise" }],
  },
  {
    id: "sampler",
    label: "Sampler",
    type: "select",
    default: "er_sde",
    options: [
      {
        value: "euler",
        label: "Euler",
        help: "Kontext's template. Smooth, and apt to redraw a face as someone else.",
      },
      {
        value: "dpmpp_2m",
        label: "DPM++ 2M",
        help: "A little more fine detail than Euler.",
      },
      {
        value: "deis",
        label: "DEIS",
        help: "Sharper texture; pairs well with the Beta schedule.",
      },
      {
        value: "er_sde",
        label: "ER-SDE",
        help: "The default. Keeps faces and skin texture; wants 16 steps or more.",
      },
      {
        value: "res_multistep",
        label: "RES multistep",
        help: "Holds detail at low step counts.",
      },
    ],
    targets: [{ node: EDIT_SAMPLER_NODE, input: "sampler_name" }],
  },
  {
    id: "scheduler",
    label: "Schedule",
    type: "select",
    default: "beta",
    options: [
      {
        value: "beta",
        label: "Beta",
        help: "The default. Spends more steps on fine detail at the end.",
      },
      { value: "simple", label: "Simple", help: "Kontext's template." },
      { value: "sgm_uniform", label: "SGM uniform" },
      { value: "normal", label: "Normal" },
    ],
    targets: [{ node: EDIT_SAMPLER_NODE, input: "scheduler" }],
  },
];

/** What every tunable control is at when nobody has touched it. */
export const IMAGE_EDIT_DEFAULTS: Record<string, ParamValue> =
  Object.fromEntries(
    IMAGE_EDIT_SETTINGS.map((param) => [param.id, param.default]),
  );
