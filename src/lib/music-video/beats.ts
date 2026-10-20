import type { Onset } from "./scenes";

/**
 * Where a song's cuts want to fall, measured in the browser.
 *
 * Nothing on the ComfyUI side analyses audio and nothing that writes a plan
 * can hear, so this is the one place the app learns anything about the music
 * itself. Two things, both cheap enough to run on a phone:
 *
 * - **Onsets**, by spectral flux — the summed rise in log magnitude across the
 *   spectrum from one frame to the next. A drum hit, a chord change and a
 *   vocal entry all show up as a jump in it, and a cut placed on one reads as
 *   cut to the music.
 * - **Loudness** over a window, for telling the planner a quiet intro from a
 *   full chorus.
 *
 * Mono at a fixed analysis rate, whatever the file was: the browser resamples
 * on decode, and 22 050 Hz keeps everything a beat lives in.
 */

export const ANALYSIS_RATE = 22050;
const FRAME = 1024;
const HOP = 512;

export interface SongAnalysis {
  seconds: number;
  onsets: Onset[];
  /** Mean loudness over a window, 0–1 relative to the loudest second. */
  loudness: (start: number, end: number) => number;
}

/** Decode a song and analyse it. Browser only. */
export async function analyseSong(bytes: ArrayBuffer): Promise<SongAnalysis> {
  // An offline context at the analysis rate decodes and resamples in one step.
  const context = new OfflineAudioContext(1, ANALYSIS_RATE, ANALYSIS_RATE);
  const buffer = await context.decodeAudioData(bytes);
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      mono[i] += data[i] / buffer.numberOfChannels;
    }
  }
  return analyseSamples(mono, buffer.sampleRate);
}

/** The analysis on raw mono samples. Pure, so it can be tested off a browser. */
export function analyseSamples(mono: Float32Array, rate: number): SongAnalysis {
  const frames = Math.max(0, Math.floor((mono.length - FRAME) / HOP) + 1);
  const window = hann(FRAME);
  const bins = FRAME / 2;
  let previous = new Float32Array(bins);
  const flux = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);

  for (let f = 0; f < frames; f += 1) {
    const offset = f * HOP;
    let energy = 0;
    for (let i = 0; i < FRAME; i += 1) {
      const sample = mono[offset + i];
      energy += sample * sample;
      re[i] = sample * window[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(energy / FRAME);
    fft(re, im);
    const current = new Float32Array(bins);
    let rise = 0;
    for (let k = 0; k < bins; k += 1) {
      current[k] = Math.log1p(10 * Math.hypot(re[k], im[k]));
      const delta = current[k] - previous[k];
      if (delta > 0) rise += delta;
    }
    flux[f] = rise;
    previous = current;
  }

  const frameSeconds = HOP / rate;
  const onsets = pickPeaks(flux, frameSeconds);

  // Loudness on a one-second scale, so a single hit does not count as loud.
  const perSecond = Math.max(1, Math.round(1 / frameSeconds));
  const smooth = movingMean(rms, perSecond);
  let loudest = 0;
  for (const value of smooth) loudest = Math.max(loudest, value);
  const loudness = (start: number, end: number): number => {
    const from = Math.max(0, Math.floor(start / frameSeconds));
    const to = Math.min(smooth.length, Math.ceil(end / frameSeconds));
    if (to <= from || loudest === 0) return 0;
    let sum = 0;
    for (let i = from; i < to; i += 1) sum += smooth[i];
    return Math.round((sum / (to - from) / loudest) * 100) / 100;
  };

  return { seconds: mono.length / rate, onsets, loudness };
}

/**
 * Local maxima of the flux that stand clear of their neighbourhood: above the
 * moving mean around them by a margin, and the biggest within about a tenth of
 * a second either side.
 */
function pickPeaks(flux: Float32Array, frameSeconds: number): Onset[] {
  const span = Math.max(1, Math.round(0.1 / frameSeconds));
  const meanSpan = Math.max(1, Math.round(0.5 / frameSeconds));
  const mean = movingMean(flux, meanSpan * 2 + 1);
  const found: { time: number; value: number }[] = [];
  let strongest = 0;

  for (let i = span; i < flux.length - span; i += 1) {
    const value = flux[i];
    if (value <= mean[i] * 1.3) continue;
    let isPeak = true;
    for (let j = i - span; j <= i + span; j += 1) {
      if (flux[j] > value) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;
    const excess = value - mean[i];
    found.push({ time: i * frameSeconds, value: excess });
    strongest = Math.max(strongest, excess);
  }

  return found.map(({ time, value }) => ({
    time: Math.round(time * 1000) / 1000,
    strength: strongest > 0 ? Math.round((value / strongest) * 1000) / 1000 : 0,
  }));
}

function movingMean(values: Float32Array, width: number): Float32Array {
  const out = new Float32Array(values.length);
  const half = Math.floor(width / 2);
  let sum = 0;
  let count = 0;
  // A running window: add the value entering on the right, drop the one
  // leaving on the left.
  for (let i = 0; i < Math.min(half, values.length); i += 1) {
    sum += values[i];
    count += 1;
  }
  for (let i = 0; i < values.length; i += 1) {
    const enter = i + half;
    if (enter < values.length) {
      sum += values[enter];
      count += 1;
    }
    const leave = i - half - 1;
    if (leave >= 0) {
      sum -= values[leave];
      count -= 1;
    }
    out[i] = sum / count;
  }
  return out;
}

function hann(size: number): Float32Array {
  const out = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    out[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  return out;
}

/** In-place radix-2 FFT. `re.length` must be a power of two. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k += 1) {
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}
