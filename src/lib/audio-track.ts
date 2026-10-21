/**
 * Whether a video file carries an audio track, read off its container.
 *
 * Asked because VHS's loader cannot answer it gracefully: its soundtrack output
 * is decoded lazily by ffmpeg the first time something reads it, and on a clip
 * with no audio stream that decode raises — "VHS failed to extract audio from
 * …" — and takes the whole run with it. A silent film or a screen recording is
 * a perfectly good clip to remix, so the question has to be settled before the
 * graph is built rather than discovered halfway through it.
 *
 * Read from the container rather than by asking a decoder, because the answer
 * is in the header and every file that reaches here is already in memory: an
 * MP4 or MOV says what each track is in its `hdlr` box, a WebM or Matroska file
 * in each track's `TrackType`. Neither needs the media itself.
 *
 * Null means the file is not a container this recognises, or one whose header
 * it could not find. Callers treat that as "has audio", which is what every
 * run assumed before this existed — an unanswered question must not throw away
 * a soundtrack that is there.
 */
export function hasAudioTrack(bytes: Uint8Array): boolean | null {
  if (isMatroska(bytes)) return matroskaHasAudio(bytes);
  return mp4HasAudio(bytes);
}

/**
 * What a clip with no soundtrack is named when it goes into ComfyUI's input
 * directory, so that the graph built for it later can tell.
 *
 * In the name because the name is the one thing that travels: it is the param
 * value, so it survives a reload, a rerun and a clip restored from history, and
 * the workflow's `finalize` can read it without anything else being sent. A
 * prefix rather than a suffix because ComfyUI keeps a name unique by appending
 * " (1)" before the extension, and rather than a subfolder because VHS's loader
 * only lists the input directory's top level.
 */
const SILENT_CLIP_PREFIX = "noaudio--";

/** Whether a loader's file reference names a clip stored as silent. */
export function isSilentClip(ref: unknown): boolean {
  const name = String(ref ?? "").split("/").pop() ?? "";
  return name.startsWith(SILENT_CLIP_PREFIX);
}

const VIDEO_EXTENSIONS = /\.(mp4|webm|mkv|mov|m4v)$/i;

/**
 * The name to store a file under: marked as silent when it is a video with no
 * audio track, and left alone otherwise — a picture, a track, a clip with
 * sound, or one whose container this could not read.
 */
export async function storedClipName(file: Blob, name: string): Promise<string> {
  const isVideo = file.type.startsWith("video/") || VIDEO_EXTENSIONS.test(name);
  if (!isVideo || isSilentClip(name)) return name;
  const audio = hasAudioTrack(new Uint8Array(await file.arrayBuffer()));
  return audio === false ? `${SILENT_CLIP_PREFIX}${name}` : name;
}

/** Matroska and WebM both open with the EBML magic. */
function isMatroska(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  );
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(
    bytes[at],
    bytes[at + 1],
    bytes[at + 2],
    bytes[at + 3],
  );
}

function uint32(bytes: Uint8Array, at: number): number {
  return (
    bytes[at] * 0x1000000 +
    ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3])
  );
}

/** The boxes whose children are boxes, on the way from the top to a `hdlr`. */
const MP4_CONTAINERS = new Set(["moov", "trak", "mdia"]);

/**
 * MP4 and MOV: walk the boxes down `moov > trak > mdia > hdlr` and look for a
 * track whose handler is `soun`.
 *
 * Every track has exactly one `hdlr` under its `mdia`, and its handler type is
 * the four bytes after the version, flags and a reserved word. Null when there
 * is no `moov` at all — not an MP4, or one truncated before its header.
 */
function mp4HasAudio(bytes: Uint8Array): boolean | null {
  let sawMoov = false;

  const walk = (start: number, end: number): boolean => {
    let at = start;
    while (at + 8 <= end) {
      let size = uint32(bytes, at);
      const type = fourcc(bytes, at + 4);
      let header = 8;
      if (size === 1) {
        // A 64-bit size follows. Past 2^53 is not a file anyone uploads.
        if (at + 16 > end) return false;
        size = uint32(bytes, at + 8) * 0x100000000 + uint32(bytes, at + 12);
        header = 16;
      } else if (size === 0) {
        size = end - at;
      }
      if (size < header || at + size > end) return false;

      if (type === "moov") sawMoov = true;
      if (MP4_CONTAINERS.has(type)) {
        if (walk(at + header, at + size)) return true;
      } else if (type === "hdlr" && at + header + 12 <= end) {
        if (fourcc(bytes, at + header + 8) === "soun") return true;
      }
      at += size;
    }
    return false;
  };

  const found = walk(0, bytes.length);
  return found ? true : sawMoov ? false : null;
}

const EBML_SEGMENT = 0x18538067;
const EBML_TRACKS = 0x1654ae6b;
const EBML_TRACK_ENTRY = 0xae;
const EBML_TRACK_TYPE = 0x83;
const EBML_CLUSTER = 0x1f43b675;
/** `TrackType` 2 is audio. */
const TRACK_TYPE_AUDIO = 2;

/** An EBML variable-length integer: its value and how many bytes it took. */
function vint(
  bytes: Uint8Array,
  at: number,
  keepMarker: boolean,
): { value: number; length: number; unknown: boolean } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length += 1;
  if (at + length > bytes.length) return null;

  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

/**
 * WebM and Matroska: find `Segment > Tracks` and look for a `TrackEntry` whose
 * `TrackType` is audio.
 *
 * A browser's MediaRecorder writes the Segment, and its Clusters, with an
 * unknown size, so neither can be skipped over — but the Tracks element comes
 * before the first Cluster in every file a recorder or an encoder writes, so
 * the walk stops at the first Cluster it reaches and never needs to.
 */
function matroskaHasAudio(bytes: Uint8Array): boolean | null {
  const elements = function* (start: number, end: number) {
    let at = start;
    while (at < end) {
      const id = vint(bytes, at, true);
      if (!id) return;
      const size = vint(bytes, at + id.length, false);
      if (!size) return;
      const body = at + id.length + size.length;
      const bodyEnd = size.unknown ? end : Math.min(end, body + size.value);
      yield { id: id.value, body, bodyEnd };
      if (size.unknown) return;
      at = bodyEnd;
    }
  };

  for (const top of elements(0, bytes.length)) {
    if (top.id !== EBML_SEGMENT) continue;
    for (const child of elements(top.body, top.bodyEnd)) {
      if (child.id === EBML_CLUSTER) return null;
      if (child.id !== EBML_TRACKS) continue;
      for (const entry of elements(child.body, child.bodyEnd)) {
        if (entry.id !== EBML_TRACK_ENTRY) continue;
        for (const field of elements(entry.body, entry.bodyEnd)) {
          if (
            field.id === EBML_TRACK_TYPE &&
            bytes[field.bodyEnd - 1] === TRACK_TYPE_AUDIO
          ) {
            return true;
          }
        }
      }
      return false;
    }
  }
  return null;
}
