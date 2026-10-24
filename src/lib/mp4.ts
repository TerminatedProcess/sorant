/**
 * How long an MP4 is, from its header alone.
 *
 * The movie header (`mvhd`, inside `moov`) holds the duration and the timescale
 * it is counted in. ComfyUI's savers write `moov` at the front, right after
 * `ftyp`, so the first read nearly always has it; a file with `moov` after its
 * media is followed box by box, reading only each box's own header.
 *
 * `read` returns the bytes from `start` up to `end` exclusive, or fewer at the
 * end of the file.
 */
export async function mp4Seconds(
  read: (start: number, end: number) => Promise<Uint8Array>,
): Promise<number | null> {
  const FIRST_READ = 4096;
  let chunk = await read(0, FIRST_READ);
  let chunkStart = 0;
  let offset = 0;

  for (let boxes = 0; boxes < 64; boxes += 1) {
    if (offset + 8 > chunkStart + chunk.length) {
      chunk = await read(offset, offset + FIRST_READ);
      chunkStart = offset;
      if (chunk.length < 8) return null;
    }
    const at = offset - chunkStart;
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let size = view.getUint32(at);
    const type = String.fromCharCode(...chunk.subarray(at + 4, at + 8));
    let header = 8;
    if (size === 1) {
      if (at + 16 > chunk.length) {
        chunk = await read(offset, offset + FIRST_READ);
        chunkStart = offset;
        continue;
      }
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    }
    if (type === "moov") {
      // `mvhd` is the first thing in `moov`, and short: usually already read.
      const start = at + header;
      const body =
        start + 128 <= chunk.length
          ? chunk.subarray(start, start + 128)
          : await read(offset + header, offset + header + 128);
      return mvhdSeconds(body);
    }
    if (size < header) return null;
    offset += size;
  }
  return null;
}

function mvhdSeconds(moov: Uint8Array): number | null {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  if (moov.length < 8 || String.fromCharCode(...moov.subarray(4, 8)) !== "mvhd") return null;
  const version = moov[8];
  // Version 1 has 64-bit creation and modification times, and duration.
  const timescaleAt = version === 1 ? 8 + 4 + 16 : 8 + 4 + 8;
  if (moov.length < timescaleAt + (version === 1 ? 12 : 8)) return null;
  const timescale = view.getUint32(timescaleAt);
  const duration =
    version === 1 ? Number(view.getBigUint64(timescaleAt + 4)) : view.getUint32(timescaleAt + 4);
  return timescale > 0 ? duration / timescale : null;
}
