#!/usr/bin/env node
/**
 * Edator — audio envelope / onset analysis.
 *
 * This is the "waveform" the editor cuts to. We decode the audio to raw PCM and
 * compute RMS energy per short window (dBFS), then derive a noise floor and find
 * exactly where speech starts and stops — the frame-accurate cut points that the
 * transcript (which only gives approximate word times) can't.
 *
 * Usage:
 *   node envelope.js <media> [--window 0.02] [--from 0] [--to 10] [--print]
 *     --print  dump the per-window dB profile (else just onsets/offsets)
 *
 * Output JSON: { floorDb, windows:[{t,db}], speech:[{start,end}] }
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const input = resolve(args[0] || "");
if (!input || !existsSync(input)) { console.error("media not found"); process.exit(1); }
const opt = (k, d) => { const i = args.indexOf(k); return i !== -1 ? +args[i + 1] : d; };
const win = opt("--window", 0.02);          // 20ms windows
const from = opt("--from", 0);
const to = opt("--to", 0);                    // 0 = whole file
const doPrint = args.includes("--print");

const SR = 16000;
const ff = ["-v", "error"];
if (from) ff.push("-ss", String(from));
if (to) ff.push("-to", String(to));
ff.push("-i", input, "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "-");
const out = spawnSync("ffmpeg", ff, { maxBuffer: 1 << 30 });
if (out.status !== 0) { console.error(out.stderr?.toString()); process.exit(1); }

const pcm = new Int16Array(out.stdout.buffer, out.stdout.byteOffset, Math.floor(out.stdout.length / 2));
const wlen = Math.max(1, Math.round(win * SR));
const windows = [];
for (let i = 0; i + wlen <= pcm.length; i += wlen) {
  let sum = 0;
  for (let j = i; j < i + wlen; j++) { const v = pcm[j] / 32768; sum += v * v; }
  const rms = Math.sqrt(sum / wlen);
  const db = rms > 0 ? 20 * Math.log10(rms) : -120;
  windows.push({ t: +(from + (i / SR)).toFixed(3), db: +db.toFixed(1) });
}

// Noise floor = 20th percentile of window energies.
const sorted = windows.map((w) => w.db).sort((a, b) => a - b);
const floorDb = sorted[Math.floor(sorted.length * 0.2)] ?? -60;
const thresh = floorDb + 12;          // speech = 12dB above the floor
const minSpeech = 0.08, minGap = 0.15; // debounce (s)

const speech = [];
let cur = null;
for (const w of windows) {
  if (w.db >= thresh) {
    if (!cur) cur = { start: w.t, end: w.t + win };
    else cur.end = w.t + win;
  } else if (cur && w.t - cur.end > minGap) {
    if (cur.end - cur.start >= minSpeech) speech.push({ start: +cur.start.toFixed(3), end: +cur.end.toFixed(3) });
    cur = null;
  }
}
if (cur && cur.end - cur.start >= minSpeech) speech.push({ start: +cur.start.toFixed(3), end: +cur.end.toFixed(3) });

const result = { floorDb: +floorDb.toFixed(1), threshDb: +thresh.toFixed(1), windowSec: win, speech };
if (doPrint) result.windows = windows;
console.log(JSON.stringify(result, null, 2));
