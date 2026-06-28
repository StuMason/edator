#!/usr/bin/env node
/**
 * Edator caption exporter — SRT + VTT sidecars for a finished cut.
 *
 * The renderer burns no captions on the long master (the Signal cards replace
 * them), so an uploaded SRT/VTT is what gives you silent-autoplay captions on
 * LinkedIn/X, YouTube search indexing, accessibility and viewer caption control.
 * The word timings already exist in the AssemblyAI transcript — this is the
 * serialization step, not new data (POLISH-BACKLOG #5).
 *
 * The catch: the transcript is in SOURCE time, the master is in OUTPUT time after
 * the cut drops, reorders and speed-changes segments. So we PROJECT every word
 * through the same timeline mapping the renderer uses (timeline.js) — a word only
 * survives if it falls inside a kept segment whose HEARD audio is the transcript's
 * source, and it lands at that segment's output position. Bleeped words are
 * grawlix-masked (f***) so the captions never print what the bleep hid.
 *
 * Usage:
 *   node captions.js <pack.json> <transcript.json> [-o <out>] [--source <key>]
 *     [--max-words N] [--max-dur S] [--max-gap S]
 *
 *   -o <out>      output stem or file; writes <out>.srt and <out>.vtt
 *                 (default: alongside the pack, <pack-stem>.srt/.vtt)
 *   --source      transcript's source roll key (default: the pack's audio bed)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { segOutDur, segAudioKey } from "./timeline.js";

const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
if (!argv[0] || argv.includes("-h") || argv.includes("--help")) {
  console.log("Usage: node captions.js <pack.json> <transcript.json> [-o <out>] [--source <key>]");
  process.exit(argv[0] ? 0 : 1);
}
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const packPath = resolve(argv[0]);
const transcriptPath = resolve(argv[1] || die("need <transcript.json>"));
const pack = JSON.parse(readFileSync(packPath, "utf8"));
const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
const words = transcript.words || [];
if (!words.length) die("transcript has no `words` array (need word-level timestamps)");

const sourceKey = flag("--source") || pack.audio || die("no --source and pack has no audio bed to infer it from");
const maxWords = +(flag("--max-words", "7"));
const maxDur = +(flag("--max-dur", "3.4"));
const maxGap = +(flag("--max-gap", "0.7"));

// ── project source-time words onto the output timeline ──────────────────────
// Cumulative output start for each segment, mirroring the renderer's concat.
const starts = [];
{ let t = 0; for (const s of pack.timeline) { starts.push(t); t += segOutDur(s); } }

// A word's bleep status in a segment: does its source span overlap any bleep?
const isBleeped = (seg, ws, we) =>
  (seg.bleeps || []).some((b) => we > b.start && ws < b.end);

// Grawlix-mask a word: keep the first letter, star the rest (so "fuck" → "f***").
const grawlix = (text) => {
  const m = text.match(/^(\W*)(\w)(\w*)(\W*)$/);
  if (!m) return "*".repeat(Math.max(1, text.length));
  return m[1] + m[2] + "*".repeat(Math.max(1, m[3].length)) + m[4];
};

const projected = [];   // { start, end, text }  in OUTPUT seconds, in output order
for (const seg of pack.timeline) {
  if (segAudioKey(seg, pack) !== sourceKey) continue;   // this segment isn't hearing the transcript's roll
  const sp = seg.speed || 1;
  const outBase = starts[pack.timeline.indexOf(seg)];
  const outEnd = outBase + segOutDur(seg);
  for (const w of words) {
    const ws = w.start / 1000, we = w.end / 1000;
    if (ws < seg.start || ws >= seg.end) continue;       // word doesn't start inside this kept span
    const oS = +(outBase + (ws - seg.start) / sp).toFixed(3);
    const oE = +Math.min(outEnd, outBase + (we - seg.start) / sp).toFixed(3);
    if (oE <= oS) continue;
    const text = isBleeped(seg, ws, we) ? grawlix(w.text) : w.text;
    projected.push({ start: oS, end: oE, text });
  }
}
projected.sort((a, b) => a.start - b.start);
if (!projected.length) die(`no words projected — is --source "${sourceKey}" the transcribed roll?`);

// ── group words into readable cues ──────────────────────────────────────────
const cues = [];
let cur = null;
const endsSentence = (t) => /[.?!]["')\]]?$/.test(t);
for (const w of projected) {
  const breakNow = cur && (
    cur.words.length >= maxWords ||
    w.start - cur.end > maxGap ||
    w.end - cur.start > maxDur ||
    endsSentence(cur.words[cur.words.length - 1])
  );
  if (!cur || breakNow) { cur = { start: w.start, end: w.end, words: [w.text] }; cues.push(cur); }
  else { cur.end = w.end; cur.words.push(w.text); }
}
const cueText = (c) => c.words.join(" ").replace(/\s+([,.?!;:])/g, "$1");

// A word that ends a cut can leave a sub-second cue that flashes by unreadable.
// Extend any short cue toward a 0.9s floor, but never past the next cue's start.
const MIN_CUE = 0.9;
for (let i = 0; i < cues.length; i++) {
  const next = cues[i + 1];
  const ceiling = next ? next.start - 0.001 : cues[i].end + MIN_CUE;
  if (cues[i].end - cues[i].start < MIN_CUE) cues[i].end = +Math.min(ceiling, cues[i].start + MIN_CUE).toFixed(3);
}

// ── serialize ───────────────────────────────────────────────────────────────
const pad = (n, w) => String(n).padStart(w, "0");
function stamp(t, sep) {
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const s = Math.floor(t) % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${sep}${pad(ms, 3)}`;
}
const srt = cues.map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${cueText(c)}`).join("\n\n") + "\n";
const vtt = "WEBVTT\n\n" + cues.map((c, i) => `${i + 1}\n${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${cueText(c)}`).join("\n\n") + "\n";

const outArg = flag("-o");
const stem = outArg
  ? resolve(outArg).replace(/\.(srt|vtt)$/i, "")
  : join(dirname(packPath), basename(packPath).replace(/\.json$/, ""));
writeFileSync(`${stem}.srt`, srt);
writeFileSync(`${stem}.vtt`, vtt);
console.log(`✓ ${cues.length} cues from ${projected.length} words → ${stem}.srt + .vtt`);
