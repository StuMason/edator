#!/usr/bin/env node
/**
 * Edator pack scorecard + contact sheet — the closing feedback signal.
 *
 * The authoring loop is record → pack → render, with nothing telling the editor
 * (Claude) whether the cut is any good. This is that signal. It reads a pack (and,
 * optionally, the rendered MP4) and reports against four dimensions, so "it got
 * better" is measurable instead of vibes:
 *
 *   TIGHTNESS    runtime, segment distribution, draggers, churn
 *   VARIETY      %talking-head, move histogram, longest static stretch
 *   CORRECTNESS  validation, warm-audio compliance, captions in-bounds, joins
 *   CEILING      inventory of the ambitious moves attempted (subjective read needs
 *                the contact sheet)
 *
 * Usage:
 *   node report.js <pack.json>                       # scorecard (pack only, fast)
 *   node report.js <pack.json> --json                # same, machine-readable
 *   node report.js <pack.json> --contact <out.mp4>   # also build a contact sheet PNG
 *       [--sheet <path.png>] [--cols N]
 *
 * The contact sheet samples one frame at the middle of each segment's *output*
 * window and tiles them, labelled, so framing / captions / roll-switches can be
 * eyeballed without watching anything.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { dirname, resolve, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validatePack } from "./validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const die = (m) => { console.error(`✗ ${m}`); process.exit(2); };

const DRAGGER = 12;     // a single segment longer than this drags
const CHURN = 0.5;      // shorter than this is churn (unless it's a deliberate stutter)
const TH_TARGET = 0.6;  // talking-head above this earns a warning

// ---- metrics (pack only) --------------------------------------------------
function analyse(pack) {
  const segs = pack.timeline;
  const out = pack.output || {};
  const dur = (s) => (s.end - s.start) / (s.speed || 1);   // OUTPUT seconds (speed-aware)
  const isImage = (k) => !!pack.sources[k]?.image;

  const durations = segs.map(dur);
  const total = durations.reduce((a, b) => a + b, 0);

  // A "static talking-head" segment: a moving roll with no pip, zoom, or captions.
  const isStatic = (s) => !isImage(s.source) && !s.pip && !s.zoom && !(s.captions && s.captions.length);
  const thTime = segs.filter(isStatic).reduce((a, s) => a + dur(s), 0);

  // longest consecutive static stretch (seconds)
  let longestStatic = 0, run = 0;
  for (const s of segs) { run = isStatic(s) ? run + dur(s) : 0; longestStatic = Math.max(longestStatic, run); }

  const moves = {
    cut: segs.length,
    rollSwitch: segs.reduce((n, s, i) => n + (i > 0 && s.source !== segs[i - 1].source ? 1 : 0), 0),
    sources: new Set(segs.map((s) => s.source)).size,
    pip: segs.filter((s) => s.pip).length,
    zoom: segs.filter((s) => s.zoom).length,
    image: segs.filter((s) => isImage(s.source)).length,
    speed: segs.filter((s) => s.speed != null).length,
    push: segs.filter((s) => s.zoom === "push" || (s.zoom && typeof s.zoom === "object" && (s.zoom.from != null || s.zoom.to != null))).length,
    chapter: segs.filter((s) => s.chapter).length,
    transition: segs.filter((s) => s.transition).length,
    capEditor: segs.reduce((n, s) => n + (s.captions || []).filter((c) => c.style === "editor").length, 0),
    capLabel: segs.reduce((n, s) => n + (s.captions || []).filter((c) => c.style === "label").length, 0),
    capPlain: segs.reduce((n, s) => n + (s.captions || []).filter((c) => !c.style || c.style === "plain").length, 0),
    music: out.music ? 1 : 0,
  };

  // Roll balance: how much runtime each source actually gets on screen. A
  // screen-share video that never shows the screen reads as "face 95%" here —
  // the exact fault a green scorecard once missed.
  const rollTime = {};
  for (const s of segs) rollTime[s.source] = (rollTime[s.source] || 0) + dur(s);
  const rollBalance = Object.entries(rollTime)
    .map(([source, t]) => ({ source, pct: total ? t / total : 0 }))
    .sort((a, b) => b.pct - a.pct);
  const multiRoll = rollBalance.length > 1;
  const topRoll = rollBalance[0] || { source: "-", pct: 0 };

  const draggers = segs.map((s, i) => ({ i, d: dur(s) })).filter((x) => x.d > DRAGGER);
  const churn = segs.map((s, i) => ({ i, d: dur(s) })).filter((x) => x.d < CHURN);
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  // warm-audio compliance: a transparent lift+limiter, not denoise/EQ/loudnorm.
  const af = out.audioFilter || "";
  const audioBad = /loudnorm|afftdn|anlmdn|equalizer|highpass|lowpass/i.test(af);
  const audioWarm = /alimiter/i.test(af) && !audioBad;

  // distinct kinds of move actually used (for a variety read)
  const moveKinds = ["rollSwitch", "pip", "zoom", "push", "image", "speed", "chapter", "transition", "capEditor", "capLabel", "music"]
    .filter((k) => moves[k] > 0).length;

  return { total, count: segs.length, durations, median, thTime, thPct: total ? thTime / total : 0,
    longestStatic, moves, moveKinds, draggers, churn, audioWarm, audioBad, audioFilter: af,
    rollBalance, multiRoll, topRoll };
}

function fmt(n, d = 1) { return Number(n).toFixed(d); }

function scorecard(pack, m, validation) {
  const L = [];
  const title = pack.meta?.title || "(untitled)";
  L.push(`EDIT SCORECARD — ${title}`);
  L.push(`runtime ${fmt(m.total)}s · ${m.count} segments · median seg ${fmt(m.median)}s`);
  L.push("");

  // TIGHTNESS
  const tFlags = [];
  if (m.draggers.length) tFlags.push(`${m.draggers.length} dragger(s) >${DRAGGER}s [seg ${m.draggers.map((x) => x.i).join(",")}]`);
  if (m.churn.length) tFlags.push(`${m.churn.length} sub-${CHURN}s churn`);
  L.push(`TIGHTNESS    ${tFlags.length ? "⚠ " + tFlags.join(" · ") : "✓ no draggers, no churn"}`);

  // VARIETY
  const vFlags = [];
  if (m.thPct > TH_TARGET) vFlags.push(`talking-head ${Math.round(m.thPct * 100)}% (>${TH_TARGET * 100}%)`);
  if (m.longestStatic > 15) vFlags.push(`${fmt(m.longestStatic)}s static stretch`);
  const mv = m.moves;
  L.push(`VARIETY      talking-head ${Math.round(m.thPct * 100)}% · ${m.moveKinds} move-kinds · ` +
    `roll×${mv.rollSwitch} pip×${mv.pip} zoom×${mv.zoom} img×${mv.image} cap(ed${mv.capEditor}/lab${mv.capLabel}/pl${mv.capPlain})` +
    (mv.speed ? ` speed×${mv.speed}` : "") + (mv.transition ? ` trans×${mv.transition}` : "") + (mv.music ? " music" : ""));
  if (vFlags.length) L.push(`             ⚠ ${vFlags.join(" · ")}`);

  // ROLLS — what's actually on screen, and for how long
  const balStr = m.rollBalance.map((r) => `${r.source} ${Math.round(r.pct * 100)}%`).join("  ");
  L.push(`ROLLS        ${balStr}`);
  if (m.multiRoll && m.topRoll.pct > 0.85) {
    L.push(`             ⚠ '${m.topRoll.source}' dominates (${Math.round(m.topRoll.pct * 100)}%) — the other roll(s) are barely shown. On a screen-share video, show the screen.`);
  }

  // CORRECTNESS
  const cFlags = [];
  if (validation.errors.length) cFlags.push(`validation: ${validation.errors.length} error(s)`);
  if (m.audioBad) cFlags.push("audio: over-processed (loudnorm/EQ/denoise — not WARM)");
  L.push(`CORRECTNESS  validation ${validation.errors.length ? "✗ FAIL" : "✓ pass"} · ` +
    `audio ${m.audioWarm ? "WARM ✓" : (m.audioFilter ? "⚠ check" : "none")} · ` +
    `captions in-bounds ${validation.errors.some((e) => e.includes("captions")) ? "✗" : "✓"}`);
  if (cFlags.length) for (const f of cFlags) L.push(`             ⚠ ${f}`);

  // CEILING
  const ambitious = [];
  if (mv.pip) ambitious.push(`${mv.pip} PiP`);
  if (mv.zoom - mv.push > 0) ambitious.push(`${mv.zoom - mv.push} punch-in`);   // static crops
  if (mv.push) ambitious.push(`${mv.push} push`);
  if (mv.capEditor) ambitious.push(`${mv.capEditor} EdAtor aside`);
  if (mv.image) ambitious.push(`${mv.image} B-roll card`);
  if (mv.speed) ambitious.push(`${mv.speed} speed-ramp`);
  if (mv.chapter) ambitious.push(`${mv.chapter} chapters`);
  if (mv.transition) ambitious.push(`${mv.transition} transition`);
  L.push(`CEILING      attempted: ${ambitious.length ? ambitious.join(", ") : "nothing beyond cuts"} ` +
    `— did they land? eyeball the contact sheet.`);

  return L.join("\n");
}

// ---- contact sheet (needs the rendered mp4) -------------------------------
function buildContactSheet(pack, m, mp4, sheetPath, cols) {
  if (!existsSync(mp4)) die(`--contact file not found: ${mp4}`);
  // output-time midpoints of each segment
  let acc = 0;
  const mids = m.durations.map((d) => { const mid = acc + d / 2; acc += d; return mid; });
  const work = mkdtempSync(join(tmpdir(), "edator-sheet-"));
  pack.timeline.forEach((s, i) => {
    const thumb = join(work, `t${String(i).padStart(3, "0")}.png`);
    const label = `${i}:${s.source}`.replace(/:/g, "\\:");
    const vf = `scale=320:-2,drawbox=x=0:y=0:w=iw:h=22:color=black@0.6:t=fill,` +
      `drawtext=text='${label}':x=5:y=3:fontsize=15:fontcolor=white`;
    spawnSync("ffmpeg", ["-v", "error", "-ss", String(mids[i].toFixed(2)), "-i", mp4, "-frames:v", "1", "-vf", vf, "-y", thumb]);
  });
  const n = pack.timeline.length;
  const c = cols || Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / c);
  const r = spawnSync("ffmpeg", ["-v", "error", "-framerate", "1", "-i", join(work, "t%03d.png"),
    "-vf", `tile=${c}x${rows}:padding=6:color=0x141413`, "-frames:v", "1", "-y", sheetPath], { encoding: "utf8" });
  if (r.status !== 0) die(`contact sheet failed: ${r.stderr}`);
  return { sheetPath, grid: `${c}x${rows}`, frames: n };
}

// ---- CLI ------------------------------------------------------------------
const argv = process.argv.slice(2);
if (!argv[0] || argv.includes("-h") || argv.includes("--help")) {
  console.log("Usage: node report.js <pack.json> [--json] [--contact <out.mp4>] [--sheet <png>] [--cols N]");
  process.exit(argv[0] ? 0 : 2);
}
const packPath = resolve(argv[0]);
if (!existsSync(packPath)) die(`Pack not found: ${packPath}`);
let pack;
try { pack = JSON.parse(readFileSync(packPath, "utf8")); }
catch (e) { die(`Not valid JSON: ${e.message}`); }
if (!Array.isArray(pack.timeline) || !pack.sources) die("Pack has no timeline/sources to report on.");

const validation = await validatePack(pack);
const m = analyse(pack);

const wantJson = argv.includes("--json");
const contactIdx = argv.indexOf("--contact");
let sheet = null;
if (contactIdx !== -1) {
  const mp4 = resolve(argv[contactIdx + 1]);
  const sheetIdx = argv.indexOf("--sheet");
  const outDir = resolve(process.cwd(), "out");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const sheetPath = sheetIdx !== -1 ? resolve(argv[sheetIdx + 1]) : join(outDir, "contact-sheet.png");
  const colsIdx = argv.indexOf("--cols");
  sheet = buildContactSheet(pack, m, mp4, sheetPath, colsIdx !== -1 ? +argv[colsIdx + 1] : 0);
}

if (wantJson) {
  console.log(JSON.stringify({ runtime: m.total, segments: m.count, medianSeg: m.median,
    talkingHeadPct: m.thPct, longestStaticSec: m.longestStatic, moves: m.moves, moveKinds: m.moveKinds,
    rollBalance: m.rollBalance, draggers: m.draggers, churn: m.churn, audioWarm: m.audioWarm, audioBad: m.audioBad,
    validationErrors: validation.errors, sheet }, null, 2));
} else {
  console.log(scorecard(pack, m, validation));
  if (sheet) console.log(`\ncontact sheet: ${sheet.sheetPath}  (${sheet.frames} frames, ${sheet.grid})`);
  if (validation.errors.length) { console.log("\nvalidation errors:"); for (const e of validation.errors) console.log(`  • ${e}`); }
}
