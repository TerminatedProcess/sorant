import type { ComfyGraph } from "@/lib/comfy";
import { ParamError } from "@/lib/params";
import {
  aspectRatioParam,
  directorTarget,
  leadingReferences,
  lookBlock,
  lookParam,
  referenceFacets,
  referenceSlot,
  type MinimaxNodeIds,
} from "./minimax-common";
import { REWRITE_IMAGE_INPUT, rewriteModelParam, rewriteNode } from "./rewrite-model";
import { SCENES_HEADING } from "@/lib/music-video/scenes";
import type { ParamDef, ParamValue, WorkflowDef } from "./types";

/**
 * A music video from a whole song and one prompt.
 *
 * This graph only plans. The browser cuts the song into scenes on its beats
 * (src/lib/music-video/), this run writes what happens in each of them, and
 * then every scene is a Reference to Video run of its own with the song locked
 * in under it, followed by a stitch that joins them and lays the song over the
 * top (music-video-stitch.ts). See `scenes`.
 *
 * Fresh scenes rather than one take extended forty times, which is how the
 * vrgamedevgirl pack's music videos hold together over four minutes: nothing
 * is carried from scene to scene except the references, so there is nothing to
 * drift. What holds the video together is the plan — one story told across the
 * scenes — and the same pictures under every one of them.
 *
 * The planner is shown the references, so it can write scenes for the subject
 * that is actually there, and is told each scene's place in the song and how
 * loud the song is across it. It cannot hear the song; the scene runs can,
 * because the song is in their latents.
 */

const PROMPT_NODE = "1";
const DIRECTOR_NODE = "2";
const BATCH_NODE = "4";
const REF_NODES = ["3", "5", "6", "7"];

const ids: Pick<MinimaxNodeIds, "director"> = { director: DIRECTOR_NODE };

/** How a slot names its input on the batch. Slot 1 is index 0. */
const batchInput = (index: number) => `images.image${index - 1}`;


export const MUSIC_VIDEO_PLANNER = `You are the director of a music video, planning it scene by scene before anything is shot.

You are given the user's idea for the video, the scenes the song has already been cut into — each with its place in the song and how loud the song is across it — and, when there are any, the reference pictures of who or what the video is about. You may also be given the song's lyrics.

You cannot hear the song. Each scene will be generated separately by a video model that can: the song is laid under every scene, and whoever performs in it performs to the real vocal. Your job is what is on screen.

Return ONLY a JSON object, with no markdown fence and nothing before or after it:

{"scenes":[{"shot":"..."},{"shot":"..."}]}

Exactly one entry per scene you were given, in the same order. Each "shot" is two to four sentences: where the scene is, what the subject does and how, and how the camera sees it. Write it as a direction to a filmmaker, in plain present-tense English.

WHAT MAKES A GOOD PLAN

One video, not a collection of clips. Decide on a concept that fits the user's idea and the lyrics — a story, a journey, a performance in a place, a contrast between two worlds — and let every scene be a moment of it, in order. The first scenes establish it and the last ones resolve it.

Follow the song's shape. The loudness of each scene is the one thing you know about the music: quiet scenes are intimate, still or atmospheric; loud ones are big, moving, performed. A run of loud scenes in the middle is a chorus — make it the video's peak, and when a chorus comes back, let it echo the first one in a new way.

Vary the coverage. Close-ups, mid shots and wide shots; a moving camera and a still one; performance to camera and moments where the subject is doing something else. Two scenes in a row should not look alike. A location may carry several scenes, but not every one of them.

Keep the subject consistent. The references define who they are and what they wear, and every scene receives the same pictures, so do not describe their face, hair or clothes, and do not change them unless the user asks. Refer to the subject plainly — "the singer", "the woman", "the dog" — never by a picture label.

Performance. When the subject is a singer and the scene is one where they would be singing, say they sing — to camera, to someone, to themselves — and how. When they are not singing, give them something to do. Never write lyrics or dialogue into a shot.

Each scene is short — the length you are given, usually four to nine seconds. One clear action or image per scene, and at most one camera move. Scenes are separated by hard cuts, so a scene does not need to begin where the last one ended.

No captions, titles, credits or on-screen text, and no other recognisable people, unless the user asks for them.`;

/**
 * The lyrics, as context for the plan rather than as anything to perform.
 *
 * The planner does not know when any line is sung — nothing here can hear the
 * song — so it is told they set the subject and the mood, and that the scenes
 * do not carry them.
 */
function lyricsBlock(values: Record<string, ParamValue>): string {
  const lyrics = String(values[LYRICS_PARAM] ?? "").trim();
  if (!lyrics) return "";
  return `THE LYRICS

These are the song's words, for what the song is about and how it feels. You do not know when each line is sung, so do not assign lines to scenes or write them into any shot. Let them shape the concept, the places and the moments.

${lyrics}`;
}

const LYRICS_PARAM = "song_lyrics";

const graph: ComfyGraph = {
  [PROMPT_NODE]: {
    class_type: "PrimitiveStringMultiline",
    inputs: { value: "" },
    _meta: { title: "Input Text (Idea and scenes)" },
  },
  [DIRECTOR_NODE]: rewriteNode({
    prompt: [PROMPT_NODE, 0],
    system: MUSIC_VIDEO_PLANNER,
    images: [BATCH_NODE, 0],
    title: "AI Gateway - Plan Scenes",
  }),
  [BATCH_NODE]: {
    class_type: "BatchImagesNode",
    inputs: {
      "images.image0": ["3", 0],
      "images.image1": ["5", 0],
      "images.image2": ["6", 0],
      "images.image3": ["7", 0],
    },
    _meta: { title: "Batch Images" },
  },
  ...Object.fromEntries(
    REF_NODES.map((node) => [
      node,
      {
        class_type: "LoadImage",
        inputs: { image: "" },
        _meta: { title: "Load Image" },
      },
    ]),
  ),
};

const director = directorTarget(
  ids,
  MUSIC_VIDEO_PLANNER,
  [referenceFacets(REF_NODES.length), lookBlock, lyricsBlock],
  // No length block: the planner is not writing one clip of a known length,
  // and each scene's own length is in the scene list.
  () => "",
);

const params: ParamDef[] = [
  {
    id: "reference_audio",
    label: "Song",
    type: "audio",
    default: "",
    required: true,
    help: "The whole song. It is cut into scenes on its beats, and each scene is made to its own stretch of it.",
    group: "Song",
    measures: "reference_track_seconds",
    scope: "scenes",
    targets: [],
  },
  {
    id: "reference_track_seconds",
    label: "Song length",
    type: "measured",
    default: 0,
    group: "Song",
    scope: "scenes",
    targets: [],
  },
  {
    id: LYRICS_PARAM,
    label: "Lyrics",
    type: "textarea",
    rows: 6,
    default: "",
    placeholder: "[Verse]\nthe words of the song",
    maxLength: 6000,
    help: "Optional. What the song is about, for the plan — nothing here knows when each line is sung, so they shape the scenes rather than being placed in them.",
    group: "Song",
    targets: [director],
  },
  {
    id: "prompt",
    label: "What the video is",
    type: "textarea",
    rows: 4,
    default: "",
    placeholder: "The singer walks home through a city at night, from an empty train platform to a packed rooftop party.",
    maxLength: 4000,
    help: "One idea for the whole video. A director turns it into a scene for every cut in the song, which you can edit before anything renders.",
    group: "Video",
    targets: [{ node: PROMPT_NODE, input: "value" }],
  },
  ...REF_NODES.flatMap((node, position) =>
    referenceSlot({
      index: position + 1,
      node,
      director,
      firstRequired: false,
    }).map(
      (param): ParamDef => ({
        ...param,
        // Every scene is its own run, so whatever a picture releases is
        // decided again in each one — a costume left to the scene changes at
        // every cut.
        ...(param.type === "select"
          ? {
              help: "Keep Everything for one consistent character. Each scene is rendered separately, so anything else lets their look change at every cut — “Identity only” re-dresses them scene by scene.",
            }
          : {}),
        // The same pictures go under every scene, with what each one keeps.
        scope: "scenes",
      }),
    ),
  ),
  {
    id: "scene_min_seconds",
    label: "Shortest scene",
    type: "slider",
    default: 4,
    min: 3,
    max: 10,
    step: 0.5,
    unit: "sec",
    help: "Cuts land on the song's beats somewhere between these two lengths.",
    group: "Video",
    scope: "browser",
    targets: [],
  },
  {
    id: "scene_max_seconds",
    label: "Longest scene",
    type: "slider",
    default: 9,
    min: 4,
    max: 15,
    step: 0.5,
    unit: "sec",
    help: "Longer scenes mean fewer runs, and each one slower. The model's sweet spot is 5 to 10 seconds.",
    group: "Video",
    scope: "browser",
    targets: [],
  },
  { ...lookParam(director), scope: "scenes" },
  { ...aspectRatioParam("unused"), scope: "scenes", targets: [] },
  {
    id: "megapixels",
    label: "Frame size",
    type: "slider",
    default: 0.5,
    min: 0.1,
    max: 1,
    step: 0.05,
    unit: "MP",
    help: "Per scene. 1 MP takes about three times as long as 0.5 MP, and a song is a dozen or more scenes.",
    group: "Output",
    scope: "scenes",
    targets: [],
  },
  {
    id: "seed",
    label: "Seed",
    type: "seed",
    default: -1,
    help: "-1 picks one at random. Each scene adds its own number to it, so a whole video can be made again exactly.",
    group: "Output",
    advanced: true,
    scope: "scenes",
    targets: [],
  },
  {
    ...rewriteModelParam(graph, [DIRECTOR_NODE]),
    // The same model writes the plan and every scene's brief.
    scope: "scenes",
  },
];

export const musicVideo: WorkflowDef = {
  id: "music-video",
  name: "Music video",
  description: "A whole song and one idea, made into a video scene by scene.",
  // None: what a music video costs is a scene count times a scene's time,
  // which the picker cannot know before the song is cut. Each scene job
  // carries Reference to Video's own estimate.
  hasAudio: true,
  graph,
  params,
  scenes: { workflow: "minimax-h3-ref", stitch: "music-video-stitch" },

  /** A finished song's "Music video" button. Nothing carries: see ClipTarget. */
  clipTarget: {
    action: "musicvideo",
    accepts: "audio",
    sourceParam: "reference_audio",
  },

  finalizeCases: [
    {
      name: "a song and no pictures",
      values: { reference_audio: "song.mp3", prompt: `x\n\n${SCENES_HEADING}\n1.` },
    },
    {
      name: "a song and two pictures",
      values: {
        reference_audio: "song.mp3",
        prompt: `x\n\n${SCENES_HEADING}\n1.`,
        reference_image_1: "a.png",
        reference_image_2: "b.png",
      },
    },
  ],

  finalize(graph, values) {
    const filled = leadingReferences(values, REF_NODES.length);
    for (let index = filled + 1; index <= REF_NODES.length; index += 1) {
      delete graph[BATCH_NODE].inputs[batchInput(index)];
      delete graph[REF_NODES[index - 1]];
    }
    // No pictures, no batch: the planner works from the idea alone, and the
    // node becomes a text rewrite centrally. See the reference graph.
    if (filled === 0) {
      delete graph[DIRECTOR_NODE].inputs[REWRITE_IMAGE_INPUT];
      delete graph[BATCH_NODE];
    }
    if (!String(values.prompt ?? "").includes(SCENES_HEADING)) {
      throw new ParamError(
        "The song has not been cut into scenes yet. Load it again and wait for the scene list.",
        "reference_audio",
      );
    }
  },
};
