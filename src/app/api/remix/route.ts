import { storedClipName } from "@/lib/audio-track";
import { unauthorized } from "@/lib/auth";
import {
  getHistoryEntry,
  inputFileRef,
  uploadInputFile,
  viewFile,
} from "@/lib/comfy";
import { errorResponse } from "@/lib/errors";
import { isUnsafePath, ParamError } from "@/lib/params";
import {
  TAIL_SAVE_AUDIO,
  TAIL_SAVE_VIDEO,
  tailFileFor,
  type TailPart,
} from "@/lib/workflows/latent-tail";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Copies a finished generation into ComfyUI's input directory so it can be fed
 * back in as a source. Serves every hand-off — Remix, Extend and Create video
 * differ in what they do with the file, not in how it gets there — and the
 * image edit, whose result replaces the picture it was made from.
 *
 * The two directories are separate: a LoadVideo or LoadAudio node only sees
 * what is in `input`, and everything a workflow produces lands in `output`. So
 * a file has to be copied across before it can be reused, and nothing in
 * ComfyUI's HTTP API does that in one call.
 *
 * The copy runs server-side rather than by handing the browser a download and
 * taking an upload back: a generated clip is comfortably past the 4.5 MB
 * Vercel caps a request body at, and the round trip would move the same bytes
 * over the user's connection twice for no reason. Here they stay between this
 * function and the ComfyUI box.
 */

const SOURCE_TYPES = new Set(["output", "temp", "input"]);

/**
 * Bounded because the file is buffered in memory to be re-posted as multipart.
 * Far above what these workflows produce — a clip of a few seconds is single
 * digit megabytes — so it only catches something pathological.
 */
const MAX_BYTES = 256 * 1024 * 1024;

/**
 * Checked again here rather than trusted from the caller. The stage decides
 * which buttons to offer from the same two questions (`REUSABLE_VIDEO` and
 * `isAudioOnly` in generation-stage.tsx), but those are affordances, not
 * guards. Here the kinds are one list, because what this route does with any
 * of them is the same copy. Stills are for the image edit, whose result goes
 * back into the picture slot it was made from.
 */
const REUSABLE_EXTENSIONS =
  /\.(mp4|webm|mkv|mov|m4v|mp3|flac|wav|m4a|ogg|opus|png|jpe?g|webp)$/i;

export async function POST(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const body = (await request.json()) as {
      filename?: string;
      subfolder?: string;
      type?: string;
      /**
       * The run that made the file, when the destination wants its latent
       * tail as well. See latent-tail.ts.
       */
      tailOf?: string;
    };

    const filename = body.filename?.trim();
    const subfolder = body.subfolder?.trim() ?? "";
    const type = body.type?.trim() || "output";

    if (!filename) throw new ParamError("filename is required.", "filename");
    if (isUnsafePath(filename)) {
      throw new ParamError("Invalid filename.", "filename");
    }
    if (isUnsafePath(subfolder)) {
      throw new ParamError("Invalid subfolder.", "subfolder");
    }
    if (!SOURCE_TYPES.has(type)) {
      throw new ParamError("Invalid type.", "type");
    }
    if (!REUSABLE_EXTENSIONS.test(filename)) {
      throw new ParamError(
        "Only a video, a track or a picture can be used as a reference.",
        "filename",
      );
    }

    // Already where the loaders look — a file that was itself uploaded, or one
    // remixed twice. Copying it onto itself would be pointless work.
    if (type === "input") {
      return Response.json({
        ref: subfolder ? `${subfolder}/${filename}` : filename,
        name: filename,
        subfolder,
        type,
      });
    }

    const upstream = await viewFile({ filename, subfolder, type });

    // Refuse on the declared length before reading, so an implausible file is
    // rejected without pulling it into memory first.
    const declared = Number(upstream.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) {
      await upstream.body?.cancel();
      throw new ParamError(
        `That file is ${(declared / 1024 / 1024).toFixed(0)} MB, which is too large to reuse as a reference.`,
        "filename",
      );
    }

    const blob = await upstream.blob();
    if (blob.size === 0) {
      throw new ParamError(
        "That file is no longer on the ComfyUI server.",
        "filename",
      );
    }
    if (blob.size > MAX_BYTES) {
      throw new ParamError(
        `That file is ${(blob.size / 1024 / 1024).toFixed(0)} MB, which is too large to reuse as a reference.`,
        "filename",
      );
    }

    // Overwrite: the name comes from ComfyUI's own output directory and is
    // unique per generation, so remixing the same clip twice should land on
    // the one file rather than accumulating copies.
    //
    // Marked when it has no soundtrack, which a generation never lacks but an
    // upscale of a silent upload does. See storedClipName.
    const uploaded = await uploadInputFile(
      blob,
      await storedClipName(blob, filename),
      { overwrite: true },
    );
    const ref = inputFileRef(uploaded);
    const tailOf = body.tailOf?.trim();

    return Response.json({
      ref,
      name: uploaded.name,
      subfolder: uploaded.subfolder,
      type: uploaded.type,
      tail: tailOf ? await copyTail(tailOf, ref) : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Copies a run's latent tail into the input directory, named after the clip it
 * belongs to, and answers with that clip's reference — or null when there is
 * no tail to copy.
 *
 * Null is an ordinary answer, not a failure: a run from before tails were
 * saved, one whose history ComfyUI has since forgotten (it keeps history in
 * memory, so a restart clears it), a graph that saves none. The clip still
 * goes across, and Extend falls back to starting from its last frame.
 */
async function copyTail(promptId: string, clipRef: string): Promise<string | null> {
  try {
    const entry = await getHistoryEntry(promptId);
    const parts: Array<[TailPart, string]> = [
      ["video", TAIL_SAVE_VIDEO],
      ["audio", TAIL_SAVE_AUDIO],
    ];
    const files = parts.map(([part, node]) => {
      const saved = entry?.outputs?.[node]?.latents?.[0];
      return saved ? ([part, saved] as const) : null;
    });
    if (files.some((file) => file === null)) return null;

    for (const file of files) {
      const [part, saved] = file!;
      const upstream = await viewFile(saved);
      const blob = await upstream.blob();
      if (!upstream.ok || blob.size === 0) return null;
      // Named after the clip, which is how Extend tells whose tail it is —
      // see tailFileFor. An upload lands at the input root, so the clip's
      // reference is a bare name and so is this.
      await uploadInputFile(blob, tailFileFor(clipRef, part), {
        overwrite: true,
      });
    }
    return clipRef;
  } catch {
    return null;
  }
}
