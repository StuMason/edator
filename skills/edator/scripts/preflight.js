#!/usr/bin/env node
/**
 * Edator — pre-flight media QC.
 *
 * The mirror of report.js: report scores the OUTPUT ("did the edit land?"),
 * preflight scores the INPUT ("is this footage usable, and where are the
 * landmines?"). Run it BEFORE writing a pack so the editor never builds a cut on
 * top of a frozen, silent, clipped or variable-frame-rate window.
 *
 *   node preflight.js <source.mp4> [more...]    # MACRO: per-file health
 *   node preflight.js --pack <edit-pack.json>   # MACRO on every source + MICRO
 *                                                 projected onto the timeline
 *   node preflight.js ... --json                # machine-readable for the editor
 *
 * Two rule tiers:
 *   MACRO — per file, once: opens/duration, resolution, constant-vs-variable
 *           frame rate, audio presence, whole-file freeze/black, source loudness.
 *   MICRO — time-resolved: a TYPED dead-air map (leading/trailing/gap/pause/
 *           breath) and freeze/black spans, projected onto the cut so each
 *           landmine names the segments that land in it.
 *
 * Everything that parses or classifies is a pure exported function (tested
 * without media); ffmpeg/ffprobe orchestration wraps them.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, isAbsolute, basename } from "node:path";
import { segAudioKey } from "./timeline.js";

const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

// --- pure parsers (ffmpeg/ffprobe text → data) ---------------------------

// silencedetect prints "silence_start: X" then "silence_end: Y | silence_duration: Z".
// A trailing silence may have no _end (runs to EOF) — close it at `duration`.
export function parseSilences(stderr, duration) {
  const out = [];
  let open = null;
  for (const line of stderr.split("\n")) {
    let m = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (m) { open = Math.max(0, +m[1]); continue; }
    m = line.match(/silence_end:\s*([\d.]+)/);
    if (m && open != null) { out.push({ start: open, end: +m[1] }); open = null; }
  }
  if (open != null && duration != null) out.push({ start: open, end: duration });
  return out.map((s) => ({ ...s, dur: +(s.end - s.start).toFixed(3) }));
}

// Tag each silence with a type the editor can act on.
export function classifyDeadAir(silences, duration, { gap = 1.2, pause = 0.6 } = {}) {
  return silences.map((s) => {
    let type;
    if (s.start <= 0.3) type = "leading";                       // before the first word → trim
    else if (duration != null && s.end >= duration - 0.3) type = "trailing"; // after the last → trim
    else if (s.dur >= gap) type = "gap";                        // long think-pause → cut or speed
    else if (s.dur >= pause) type = "pause";                    // a beat → maybe tighten
    else type = "breath";                                       // natural, keep
    return { ...s, type };
  });
}

// freezedetect: "freeze_start: X" / "freeze_end: Y". Frozen-to-EOF has no _end.
export function parseFreezes(stderr, duration) {
  return parseSpans(stderr, /freeze_start:\s*([\d.]+)/, /freeze_end:\s*([\d.]+)/, duration);
}

// blackdetect: "black_start:X black_end:Y" (often same line).
export function parseBlacks(stderr, duration) {
  const out = [];
  for (const line of stderr.split("\n")) {
    const s = line.match(/black_start:\s*([\d.]+)/);
    const e = line.match(/black_end:\s*([\d.]+)/);
    if (s) out.push({ start: +s[1], end: e ? +e[1] : (duration ?? +s[1]) });
  }
  return out.map((b) => ({ ...b, dur: +(b.end - b.start).toFixed(3) }));
}

function parseSpans(stderr, startRe, endRe, duration) {
  const out = [];
  let open = null;
  for (const line of stderr.split("\n")) {
    let m = line.match(startRe);
    if (m) { open = +m[1]; continue; }
    m = line.match(endRe);
    if (m && open != null) { out.push({ start: open, end: +m[1] }); open = null; }
  }
  if (open != null && duration != null) out.push({ start: open, end: duration });
  return out.map((s) => ({ ...s, dur: +(s.end - s.start).toFixed(3) }));
}

// volumedetect: mean_volume / max_volume in dB. max near 0 = clipping; mean near
// -91 = a (probably wrongly) silent track.
export function parseVolume(stderr) {
  const mean = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  const max = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  return { mean: mean ? +mean[1] : null, max: max ? +max[1] : null };
}

// A constant frame rate has r_frame_rate ≈ avg_frame_rate. A meaningful gap means
// VFR, which silently breaks frame-accurate cutting.
export function fpsVerdict(rFrameRate, avgFrameRate) {
  const r = ratio(rFrameRate), avg = ratio(avgFrameRate);
  const vfr = r != null && avg != null && Math.abs(r - avg) / r > 0.02;
  return { r, avg, vfr };
}
const ratio = (s) => { if (!s) return null; const [n, d] = String(s).split("/").map(Number); return d ? n / d : n; };

// Which timeline segments land inside any of `spans` for `sourceKey`. role:
// "video" → the segment's visible roll or its pip; "audio" → its heard track.
export function segmentsHitting(pack, sourceKey, spans, role = "video") {
  const hits = [];
  pack.timeline.forEach((seg, i) => {
    const key = role === "audio" ? segAudioKey(seg, pack) : seg.source;
    const pipKey = role === "video" ? seg.pip?.source : null;
    if (key !== sourceKey && pipKey !== sourceKey) return;
    for (const sp of spans) {
      if (seg.end > sp.start && seg.start < sp.end) {       // source-time overlap
        hits.push({ seg: i, source: seg.source, segStart: seg.start, segEnd: seg.end, span: sp });
        break;
      }
    }
  });
  return hits;
}

// --- ffmpeg / ffprobe orchestration --------------------------------------

function probe(file) {
  const r = spawnSync("ffprobe", ["-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,sample_rate,channels",
    "-show_entries", "format=duration", "-of", "json", file], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const j = JSON.parse(r.stdout);
  const v = (j.streams || []).find((s) => s.codec_type === "video");
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  return { duration: +(j.format?.duration ?? 0), v, a };
}

const ff = (args) => spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args, "-f", "null", "-"], { encoding: "utf8" }).stderr || "";

function inspect(file) {
  const p = probe(file);
  if (!p) return { file, ok: false, error: "ffprobe could not open the file" };
  const dur = p.duration;
  const fps = p.v ? fpsVerdict(p.v.r_frame_rate, p.v.avg_frame_rate) : null;

  // One video pass (freeze + black) and one audio pass (silence + volume).
  const vText = p.v ? ff(["-i", file, "-an", "-vf", "freezedetect=n=-60dB:d=0.5,blackdetect=d=0.3:pic_th=0.98"]) : "";
  const aText = p.a ? ff(["-i", file, "-vn", "-af", "silencedetect=noise=-35dB:d=0.4,volumedetect"]) : "";

  const audio = p.a ? { codec: p.a.codec_name, sampleRate: +p.a.sample_rate, channels: +p.a.channels, ...parseVolume(aText) } : null;
  // The two-roll tell: the camera roll is silent (mic lands only on the screen
  // roll), so a SILENT roll is a face/B-roll and its freezes are real camera
  // death; a VOICED roll is the screen, whose static slides are expected, not a
  // fault. We also only hunt dead-air where there's actually speech.
  const silent = !audio || audio.mean == null || audio.mean <= -80;
  return {
    file, ok: true, duration: dur, silent,
    video: p.v ? { codec: p.v.codec_name, w: +p.v.width, h: +p.v.height, fps } : null,
    audio,
    freezes: parseFreezes(vText, dur),
    blacks: parseBlacks(vText, dur),
    deadAir: silent ? [] : classifyDeadAir(parseSilences(aText, dur), dur),
  };
}

// --- macro / micro verdicts ----------------------------------------------

// Freezes that matter: on a silent roll (a camera) they're death; on a voiced
// roll (the screen) a long static hold is just a slide — report it quietly, not
// as a fault. A short silent freeze is probably an ident/graphic, not a camera.
export function realFreezes(r) {
  if (!r.silent) return [];
  if (r.duration != null && r.duration <= 4) return [];   // an ident/sting/graphic, not a camera roll
  return r.freezes.filter((x) => x.dur >= 2);
}

function macroFlags(r) {
  const f = [];
  if (r.video?.fps?.vfr) f.push(`VARIABLE frame rate (r=${r.video.fps.r?.toFixed(2)} avg=${r.video.fps.avg?.toFixed(2)}) — breaks frame-accurate cutting`);
  const frozen = realFreezes(r);
  if (frozen.length) f.push(`FROZEN video on a silent roll: ${frozen.map((x) => `${fmt(x.start)}–${fmt(x.end)}`).join(", ")} — camera death (a face/B-roll that stopped moving)`);
  const black = r.blacks.filter((x) => x.dur >= 0.5);
  if (black.length) f.push(`BLACK video: ${black.map((x) => `${fmt(x.start)}–${fmt(x.end)}`).join(", ")}`);
  if (r.audio?.max != null && r.audio.max >= -0.1) f.push(`audio CLIPPING (max ${r.audio.max}dB) — peaks at/over 0dBFS`);
  return f;
}

const fmt = (t) => { const s = Math.floor(t % 60), m = Math.floor(t / 60); return `${m}:${String(s).padStart(2, "0")}`; };

function report(results, pack) {
  const L = [];
  for (const r of results) {
    L.push(`\n■ ${basename(r.file)}`);
    if (!r.ok) { L.push(`  ✗ ${r.error}`); continue; }
    const v = r.video, a = r.audio;
    L.push(`  ${fmt(r.duration)} · ${v ? `${v.w}×${v.h} ${v.codec} ${v.fps?.vfr ? "VFR" : `${Math.round(v.fps?.avg || 0)}fps`}` : "no video"} · ${a ? `${a.codec} ${a.channels}ch mean ${a.mean}dB max ${a.max}dB` : "no audio"}`);
    const flags = macroFlags(r);
    if (flags.length) flags.forEach((f) => L.push(`  ⚠ ${f}`));
    else L.push("  ✓ macro clean");
    if (r.silent) L.push("  · silent roll (camera/B-roll) — no dead-air check; its freezes are camera death, not slides");
    // dead-air summary (the bit that matters most), voiced rolls only
    const da = r.deadAir;
    const total = da.reduce((s, x) => s + x.dur, 0);
    if (da.length) {
      const by = (t) => da.filter((x) => x.type === t);
      const parts = ["leading", "trailing", "gap", "pause", "breath"].map((t) => by(t).length ? `${by(t).length} ${t}` : null).filter(Boolean);
      L.push(`  dead air: ${total.toFixed(1)}s (${(100 * total / r.duration).toFixed(0)}% of file) — ${parts.join(", ")}`);
      const trimmable = da.filter((x) => x.type === "leading" || x.type === "trailing");
      trimmable.forEach((x) => L.push(`    · ${x.type} silence ${fmt(x.start)}–${fmt(x.end)} (${x.dur}s) → trim`));
      by("gap").forEach((x) => L.push(`    · ${x.dur}s gap at ${fmt(x.start)} → cut or speed-ramp`));
    }
  }

  // MICRO: project freeze/black/dead-air onto the timeline.
  if (pack) {
    L.push("\n── timeline landmines ──");
    let any = false;
    for (const r of results) {
      if (!r.ok) continue;
      const key = r.key;
      // Only real freezes (silent-roll camera death) + true black are landmines;
      // a static screen slide is not.
      const frozen = [...realFreezes(r), ...r.blacks.filter((x) => x.dur >= 0.5)];
      for (const h of segmentsHitting(pack, key, frozen, "video")) {
        any = true;
        L.push(`  ⚠ seg ${h.seg} (${key} ${fmt(h.segStart)}–${fmt(h.segEnd)}) lands in a dead-camera/black window ${fmt(h.span.start)}–${fmt(h.span.end)}`);
      }
      const gaps = r.deadAir.filter((x) => x.type === "gap");
      for (const h of segmentsHitting(pack, key, gaps, "audio")) {
        any = true;
        L.push(`  · seg ${h.seg} carries a ${h.span.dur}s dead-air gap at ${fmt(h.span.start)} → tighten or speed it`);
      }
    }
    if (!any) L.push("  ✓ no freeze/black/long-gap windows intersect the cut");
  }
  return L.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("-h") || argv.includes("--help")) {
    console.log("Usage: node preflight.js <source.mp4>...  |  --pack <edit-pack.json>  [--json]");
    process.exit(argv.length ? 0 : 1);
  }
  const asJson = argv.includes("--json");
  const packIdx = argv.indexOf("--pack");
  let pack = null, files = [];

  if (packIdx !== -1) {
    const packPath = resolve(argv[packIdx + 1]);
    if (!existsSync(packPath)) die(`Pack not found: ${packPath}`);
    pack = JSON.parse(readFileSync(packPath, "utf8"));
    const base = dirname(packPath);
    files = Object.entries(pack.sources)
      .filter(([, s]) => !s.image)   // stills have nothing to QC
      .map(([key, s]) => ({ key, file: isAbsolute(s.file) ? s.file : resolve(base, s.file) }));
  } else {
    files = argv.filter((a) => !a.startsWith("--")).map((file) => ({ key: null, file: resolve(file) }));
  }

  const results = files.map(({ key, file }) => {
    if (!existsSync(file)) return { file, key, ok: false, error: "file not found" };
    return { ...inspect(file), key };
  });

  if (asJson) { console.log(JSON.stringify({ sources: results }, null, 2)); return; }
  console.log(report(results, pack));
}

// Run as a CLI, stay importable for tests.
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main();
}
