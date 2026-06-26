#!/usr/bin/env node
/**
 * Edator deterministic renderer.
 *
 * Reads an edit pack (JSON edit-decision list) and produces an MP4 with FFmpeg.
 * There is NO judgement here: every cut, in/out point, roll choice, zoom, caption
 * and music cue comes straight from the pack. If the output is wrong, the pack was
 * wrong — that's the whole design. Claude decides; this executes.
 *
 * The pipeline, top to bottom:
 *   loadPack    parse + validate the JSON contract
 *   planInputs  turn `sources` + timeline into an ordered ffmpeg input list,
 *               resolving which input index each segment's video/audio reads from
 *   buildGraph  emit the filter_complex (one [vN]/[aN] pair per segment → concat,
 *               then optional audio polish + music)
 *   run         assemble ffmpeg args and spawn it
 *
 * Capabilities (all driven by the pack — see schema/edit-pack.schema.json):
 *   - cuts         timeline of [start,end) segments, concatenated in order
 *   - roll switch  each segment's `source` picks the visible roll
 *   - audio bed    a global `audio` source plays continuously under switching rolls
 *                  (lip-sync holds because the rolls share one recording clock)
 *   - per-seg audio  a segment's `audio` overrides the bed (e.g. an ident's own track)
 *   - zoom         punch-in: `zoom` number or {scale,x,y} (focus 0..1)
 *   - pip          `pip:{source,corner,width,margin}` overlays a roll in a corner
 *   - image B-roll a source with `image:true` is held as a still for the segment
 *   - captions     `captions:[{style,text,start,end}]` — editor / label / plain
 *   - music        `output.music` — bookend (introLen/outroLen) or continuous bed
 *   - audio polish `output.audioFilter` applied to the spoken mix before music
 *
 * Usage:
 *   node render.js <edit-pack.json> [--out <file.mp4>] [--dry-run]
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { dirname, resolve, isAbsolute, join } from "node:path";
import { tmpdir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { validatePack } from "./validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const even = (n) => Math.max(2, Math.round(n / 2) * 2);   // h264 needs even dimensions

// Fonts. drawtext needs a real TTF/OTF path, which differs per OS. Resolve a
// bold sans (headings / EdAtor bubbles) and a mono (eyebrow labels) from
// per-platform candidates, first match wins. Override either with EDATOR_FONT /
// EDATOR_MONO. Captions are the only thing that needs a font, so resolution is
// lazy: a pack with no captions renders even where no font is found.
const FONT_CANDIDATES = {
  darwin: ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"],
  linux: ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"],
  win32: ["C:\\Windows\\Fonts\\arialbd.ttf", "C:\\Windows\\Fonts\\arial.ttf"],
};
const MONO_CANDIDATES = {
  darwin: ["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf", "/System/Library/Fonts/SFNSMono.ttf"],
  linux: ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf", "/usr/share/fonts/TTF/DejaVuSansMono.ttf", "/usr/share/fonts/dejavu/DejaVuSansMono.ttf"],
  win32: ["C:\\Windows\\Fonts\\consola.ttf", "C:\\Windows\\Fonts\\cour.ttf"],
};
function resolveFont(envVar, candidatesByOs) {
  if (process.env[envVar]) return process.env[envVar];   // trust the override; validated lazily
  for (const c of candidatesByOs[platform()] || []) if (existsSync(c)) return c;
  return null; // nothing found — only fatal if a caption actually needs it (see needFont)
}
const FONT = resolveFont("EDATOR_FONT", FONT_CANDIDATES);
const MONO = resolveFont("EDATOR_MONO", MONO_CANDIDATES);
const needFont = (which) => {
  const mono = which === "mono";
  const f = mono ? MONO : FONT;
  const envVar = mono ? "EDATOR_MONO" : "EDATOR_FONT";
  if (!f) die(`No ${mono ? "monospace" : "bold sans"} font found for captions on ${platform()}. Set ${envVar} to a .ttf/.otf file.`);
  if (!existsSync(f)) die(`${envVar} points at a font that doesn't exist: ${f}`);
  return f;
};

// PiP / overlay corner positions, parameterised by margin (px).
const CORNERS = {
  tl: (m) => `x=${m}:y=${m}`,
  tr: (m) => `x=main_w-overlay_w-${m}:y=${m}`,
  bl: (m) => `x=${m}:y=main_h-overlay_h-${m}`,
  br: (m) => `x=main_w-overlay_w-${m}:y=main_h-overlay_h-${m}`,
};

// ---------------------------------------------------------------------------
// Captions
//
// drawtext escaping is fiddly, so every string is written to a temp textfile and
// referenced with textfile= — that sidesteps quoting/escaping entirely.
// ---------------------------------------------------------------------------
const capDir = mkdtempSync(join(tmpdir(), "edator-cap-"));
let capN = 0;
const writeCap = (txt) => { const f = join(capDir, `c${capN++}.txt`); writeFileSync(f, txt); return f; };

// Build drawtext filter(s) for one caption, timed relative to its segment start.
//   style "editor" → signed chat bubble in the Anthropic palette: this is clearly
//     EdAtor's voice (a third party messaging about the speaker), never the
//     speaker's. Auto-placed in the corner opposite the PiP via `cap.corner`.
//   style "label"  → stumasondev production eyebrow: orange UPPERCASE mono with a
//     leading dash on a navy strip. The brand's tell.
//   anything else  → a plain neutral caption.
function drawtext(cap, segStart, Wpx, Hpx, speed = 1) {
  const H = Hpx || 720;
  // Captions are authored in source-time; a sped-up segment compresses the
  // output clock, so the on-screen window divides by the speed factor.
  const a = ((cap.start - segStart) / speed).toFixed(3);
  const b = ((cap.end - segStart) / speed).toFixed(3);
  const en = `enable=between(t\\,${a}\\,${b})`;

  if (cap.style === "editor") {
    const CREAM = "0xF0EEE6", INK = "0x141413", CORAL = "0xD97757";
    const cf = Math.round(H * 0.046);     // message font
    const nf = Math.round(H * 0.030);     // sender-tag font
    const bb = Math.round(H * 0.020);     // bubble padding
    const M = Math.round(H * 0.045);      // frame margin
    const gap = Math.round(H * 0.012);
    const thC = Math.round(cf * 1.25), thN = Math.round(nf * 1.25);
    const corner = cap.corner || "br";    // collision-aware corner injected by caller
    const right = corner.endsWith("r");
    const top = corner.startsWith("t");
    const x = right ? `x=w-text_w-${M}` : `x=${M}`;
    let nameY, bubbleY;
    if (top) { nameY = M; bubbleY = M + thN + bb + gap; }
    else { bubbleY = H - M - bb - thC; nameY = bubbleY - bb - gap - thN; }
    const nameFile = writeCap(cap.by || "EdAtor");
    const msgFile = writeCap(cap.text);
    const name = `drawtext=fontfile='${needFont()}':textfile='${nameFile}':fontsize=${nf}:fontcolor=${CREAM}:box=1:boxcolor=${CORAL}@0.95:boxborderw=9:${x}:y=${nameY}:${en}`;
    const bubble = `drawtext=fontfile='${needFont()}':textfile='${msgFile}':fontsize=${cf}:fontcolor=${INK}:box=1:boxcolor=${CREAM}@0.95:boxborderw=${bb}:${x}:y=${bubbleY}:${en}`;
    return `${name},${bubble}`;
  }

  if (cap.style === "label") {
    const NAVY = "0x0B0E14", ORANGE = "0xFF5436";
    const fs = Math.round(H * (cap.size || 0.034));
    const m = Math.round(H * 0.05);
    const right = (cap.corner || "bl").endsWith("r");
    const top = (cap.corner || "bl").startsWith("t");
    const x = right ? `x=w-text_w-${m}` : `x=${m}`;
    const y = top ? `y=${m}` : `y=h-text_h-${m}`;
    const msgFile = writeCap(`—  ${String(cap.text).toUpperCase()}`);
    return `drawtext=fontfile='${needFont("mono")}':textfile='${msgFile}':fontsize=${fs}:fontcolor=${ORANGE}:` +
      `box=1:boxcolor=${NAVY}@0.82:boxborderw=16:${x}:${y}:${en}`;
  }

  // plain caption (neutral labels / future subtitles)
  const fs = Math.round(H * (cap.size || 0.05));
  const m = Math.round(H * 0.06);
  const pos = {
    bottom: `x=(w-text_w)/2:y=h-text_h-${m}`,
    top: `x=(w-text_w)/2:y=${m}`,
    tl: `x=${m}:y=${m}`, tr: `x=w-text_w-${m}:y=${m}`,
    bl: `x=${m}:y=h-text_h-${m}`, br: `x=w-text_w-${m}:y=h-text_h-${m}`,
  }[cap.pos || "bottom"];
  const msgFile = writeCap(cap.text);
  return `drawtext=fontfile='${needFont()}':textfile='${msgFile}':fontsize=${fs}:fontcolor=${cap.color || "white"}:` +
    `box=1:boxcolor=${cap.boxcolor || "black@0.55"}:boxborderw=18:${pos}:${en}`;
}

// ---------------------------------------------------------------------------
// Load & validate the pack
// ---------------------------------------------------------------------------
function loadPack(packPath) {
  if (!existsSync(packPath)) die(`Edit pack not found: ${packPath}`);
  let pack;
  try { pack = JSON.parse(readFileSync(packPath, "utf8")); }
  catch (e) { die(`Edit pack is not valid JSON: ${e.message}`); }

  if (pack.version !== "1.0" && pack.version !== "1.1") die(`Unsupported version: ${pack.version} (expected "1.0" or "1.1").`);
  if (!pack.sources || typeof pack.sources !== "object") die("Edit pack has no `sources`.");
  if (!Array.isArray(pack.timeline) || pack.timeline.length === 0) die("Edit pack `timeline` is empty.");

  pack.timeline.forEach((seg, i) => {
    if (typeof seg.start !== "number" || typeof seg.end !== "number") die(`Segment ${i} needs numeric start/end.`);
    if (seg.end <= seg.start) die(`Segment ${i}: end (${seg.end}) must exceed start (${seg.start}).`);
  });
  return pack;
}

// ---------------------------------------------------------------------------
// Plan the ffmpeg input list
//
// Returns ffmpeg inputs in the exact order they'll be passed on the command line:
//   1. deduped file sources (video/audio)          — referenced by every cut/pip/bed
//   2. one looped still per image-B-roll segment    — in timeline order
//   3. music (optional)                             — last
// Each timeline segment is stamped with `_vIdx` (its video input index) and
// `_isImage`. `indexByKey` maps source keys → input index for files (used by cuts,
// pip and audio-bed lookups). `idxOf` is the validated accessor.
// ---------------------------------------------------------------------------
function planInputs(pack, packDir) {
  const resolveSource = (file) => (isAbsolute(file) ? file : resolve(packDir, file));
  const ffInputs = [];                 // { path, loop?, dur?, framerate?, streamLoop? }
  const indexByKey = {};               // file-source key → input index
  const imagePathByKey = {};           // image-source key → absolute path

  for (const [key, src] of Object.entries(pack.sources)) {
    if (!src.file) die(`Source "${key}" has no file.`);
    const abs = resolveSource(src.file);
    if (!existsSync(abs)) die(`Source file for "${key}" not found: ${abs}`);
    if (src.image) { imagePathByKey[key] = abs; continue; }   // stills become per-segment looped inputs
    let idx = ffInputs.findIndex((fi) => fi.path === abs);
    if (idx === -1) { idx = ffInputs.length; ffInputs.push({ path: abs }); }
    indexByKey[key] = idx;
  }

  const idxOf = (key, ctx) => {
    const i = indexByKey[key];
    if (i === undefined) die(`${ctx} references unknown source "${key}".`);
    return i;
  };

  const fps = Number.isInteger(pack.output?.fps) ? pack.output.fps : 30;
  pack.timeline.forEach((seg, i) => {
    if (imagePathByKey[seg.source]) {
      seg._isImage = true;
      seg._vIdx = ffInputs.length;
      ffInputs.push({ path: imagePathByKey[seg.source], loop: true, dur: +(seg.end - seg.start).toFixed(3), framerate: fps });
    } else {
      seg._isImage = false;
      seg._vIdx = idxOf(seg.source, `Segment ${i}`);
    }
  });

  // Music input goes last so its index is stable regardless of how many stills precede it.
  let musicIdx = null;
  const bookend = !!(pack.output?.music && (pack.output.music.introLen || pack.output.music.outroLen));
  if (pack.output?.music) {
    musicIdx = ffInputs.length;
    ffInputs.push({ path: resolveSource(pack.output.music.file), streamLoop: !bookend });
  }

  return { ffInputs, indexByKey, idxOf, musicIdx, bookend };
}

// ---------------------------------------------------------------------------
// Build the filter graph
// ---------------------------------------------------------------------------

// A segment's duration on the OUTPUT clock: source span divided by any speed
// factor. The single source of truth for fade timing, chapters, music length.
function segOutDur(seg) {
  return +((seg.end - seg.start) / (seg.speed || 1)).toFixed(3);
}

// Animated push: scale up to the `to` size, then crop a window that shrinks over
// time (variable t) so apparent zoom ramps from `from` to `to`, then scale back
// to canvas. Deterministic (a plain expression, no per-frame accumulator) — and
// snapshot-stable, unlike zoompan. dur is the segment's OUTPUT duration.
function pushFilters(z, W, H, dur) {
  const from = z.from != null ? z.from : 1.0;
  const to = z.to != null ? z.to : 1.15;
  const fx = z.x != null ? z.x : 0.5;
  const fy = z.y != null ? z.y : 0.34;
  const Wto = even(W * to), Hto = even(H * to);
  const zt = `(${from}+(${to}-${from})*t/${dur.toFixed(3)})`;   // apparent zoom at time t
  return [
    `scale=${Wto}:${Hto}`,
    `crop=w='${W}*${to}/${zt}':h='${H}*${to}/${zt}':x='(in_w-out_w)*${fx}':y='(in_h-out_h)*${fy}'`,
    `scale=${W}:${H}`,
  ];
}

// Is this zoom an animated push (push shorthand or from/to) vs a static crop?
const isPush = (z) => z === "push" || (typeof z === "object" && (z.from != null || z.to != null));

// Video chain for one segment, ending at label [vN] (writes intermediate labels
// for pip). W/H may be null when the timeline is single-roll and unscaled.
function buildVideoChain(seg, i, W, H, idxOf, parts) {
  const wantScale = W && H;
  const wantFps = Number.isInteger(seg._fps);   // _fps stamped by caller from output.fps
  const speed = seg.speed || 1;
  // Speed retiming folds straight into the de-jitter setpts: /speed compresses.
  const setpts = speed !== 1 ? `setpts=(PTS-STARTPTS)/${speed}` : "setpts=PTS-STARTPTS";

  if (seg.zoom && isPush(seg.zoom) && !wantScale) die(`Segment ${i}: an animated zoom ("push") needs a canvas — set output.width/height.`);

  const base = [];
  if (seg._isImage) {
    // Held still: fit to canvas, no trim (the input is already looped to length).
    base.push(`[${seg._vIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`);
    if (seg.zoom && isPush(seg.zoom)) base.push(...pushFilters(seg.zoom === "push" ? {} : seg.zoom, W, H, segOutDur(seg)));   // Ken Burns on a still
    if (wantFps) base.push(`fps=${seg._fps}`);
    base.push("setsar=1");
  } else {
    base.push(`[${seg._vIdx}:v]trim=start=${seg.start}:end=${seg.end}`, setpts);
    if (seg.zoom && isPush(seg.zoom) && wantScale) {
      // Animated push: normalise to canvas, then ramp the zoom over the segment.
      base.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`);
      base.push(...pushFilters(seg.zoom === "push" ? {} : seg.zoom, W, H, segOutDur(seg)));
    } else if (seg.zoom && wantScale) {
      // Static punch-in: scale up then crop back to canvas. zoom = number, or
      // {scale,x,y} where x/y are focus points 0..1 (y defaults high for the face).
      const z = typeof seg.zoom === "number" ? seg.zoom : (seg.zoom.scale || 1.2);
      const fx = typeof seg.zoom === "object" && seg.zoom.x != null ? seg.zoom.x : 0.5;
      const fy = typeof seg.zoom === "object" && seg.zoom.y != null ? seg.zoom.y : 0.34;
      const sW = even(W * z), sH = even(H * z);
      base.push(`scale=${sW}:${sH}`, `crop=${W}:${H}:${Math.round((sW - W) * fx)}:${Math.round((sH - H) * fy)}`);
    } else if (wantScale) {
      base.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`);
    }
    if (wantFps) base.push(`fps=${seg._fps}`);
    base.push("setsar=1");
  }

  // Captions, timed in source-time like the cut. Editor bubbles auto-dodge the PiP:
  // cam in a right corner → bubble bottom-left, and vice-versa, so they never overlap.
  const caps = Array.isArray(seg.captions) ? seg.captions : [];
  const editorCorner = seg.pip && (seg.pip.corner || "br").endsWith("r") ? "bl" : "br";
  const capChain = caps
    .map((c) => drawtext(c.style === "editor" && !c.corner ? { ...c, corner: editorCorner } : c, seg.start, W, H, speed))
    .join(",");

  // Dip-to-black transition: fade this segment in from black at its head, and/or
  // out to black at its tail (stamped when a neighbour requests a dip). It's a
  // trailing fade on the finished frame, so the concat spine is untouched.
  // Timing is OUTPUT-clock (speed-aware), so the dip lands at the real tail.
  const segDur = segOutDur(seg);
  const tail = [];
  if (seg._dipIn) tail.push(`fade=t=in:st=0:d=${seg._dipIn}`);
  if (seg._dipOut) tail.push(`fade=t=out:st=${(segDur - seg._dipOut).toFixed(3)}:d=${seg._dipOut}`);
  // Escape valve: an opaque, unvalidated filter string, spliced in as the LAST
  // transform on this segment's finished frame (after scale/zoom/pip/captions/
  // transition). Frames in → frames out, no label refs. See issue #2.
  if (seg.rawFilter) tail.push(seg.rawFilter);
  // Where the composited frame lands before the optional trailing transforms.
  const vTerm = tail.length ? `[vpre${i}]` : `[v${i}]`;

  if (seg.pip) {
    const pIdx = idxOf(seg.pip.source, `Segment ${i} pip`);
    const pw = even((W || 1280) * (seg.pip.width || 0.25));
    const margin = Math.round((W || 1280) * (seg.pip.margin ?? 0.02));
    const pos = (CORNERS[seg.pip.corner] || CORNERS.br)(margin);
    parts.push(`${base.join(",")}[base${i}]`);
    parts.push(`[${pIdx}:v]trim=start=${seg.start}:end=${seg.end},${setpts},scale=${pw}:-2,setsar=1[pip${i}]`);
    const ovOut = capChain ? `[ov${i}]` : vTerm;
    parts.push(`[base${i}][pip${i}]overlay=${pos}:eof_action=repeat${ovOut}`);
    if (capChain) parts.push(`[ov${i}]${capChain}${vTerm}`);
  } else {
    const baseStr = base.join(",");
    parts.push(capChain ? `${baseStr},${capChain}${vTerm}` : `${baseStr}${vTerm}`);
  }
  if (tail.length) parts.push(`${vTerm}${tail.join(",")}[v${i}]`);
}

// Audio chain for one segment, ending at label [aN]. Source precedence:
// per-segment override → global bed → the segment's own roll.
//
// Boundary fades are unified here: a hard splice clicks when it lands mid-room-
// tone, so every join gets a short afade in/out. Declick is just the 5ms default;
// a "dip" transition is the same fade, longer (seg._dipIn / seg._dipOut, in s).
// atempo only accepts 0.5–2.0 per stage, so decompose a speed factor into a
// chain that multiplies back to it (e.g. 4× → atempo=2,atempo=2). Keeps audio
// in lock-step with the video's setpts retime, so A/V never drifts.
function atempoChain(speed) {
  const fs = [];
  let s = speed;
  while (s > 2.0 + 1e-9) { fs.push(2.0); s /= 2.0; }
  while (s < 0.5 - 1e-9) { fs.push(0.5); s /= 0.5; }
  fs.push(+s.toFixed(6));
  return fs.map((f) => `atempo=${f}`);
}

function buildAudioChain(seg, i, audioKey, idxOf, parts, declick) {
  const aKey = seg.audio || audioKey;
  if (seg._isImage && !aKey) die(`Segment ${i} is a B-roll still — set pack.audio or this segment's "audio" so the narration plays under it.`);
  const aIdx = aKey ? idxOf(aKey, `Segment ${i} audio`) : seg._vIdx;
  const speed = seg.speed || 1;
  const atempo = speed !== 1 ? "," + atempoChain(speed).join(",") : "";
  const dur = segOutDur(seg);   // post-atempo (output-clock) duration — fades hang off this
  const inD = seg._dipIn || (declick ? 0.005 : 0);
  const outD = seg._dipOut || (declick ? 0.005 : 0);
  const fades = [];
  if (inD && dur > inD) fades.push(`afade=t=in:d=${inD}`);
  if (outD && dur > inD + outD) fades.push(`afade=t=out:st=${(dur - outD).toFixed(3)}:d=${outD}`);
  const fx = fades.length ? "," + fades.join(",") : "";
  parts.push(`[${aIdx}:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS${atempo}${fx}[a${i}]`);
}

// Optional music tail. Bookend = intro + outro only (faded, louder); bed =
// quiet continuous track under the whole thing. Returns the final audio label.
function buildMusicTail(music, musicIdx, bookend, totalDur, inLabel, parts) {
  const vol = music.volume ?? (bookend ? 0.5 : 0.12);
  if (bookend) {
    const introLen = music.introLen ?? 6;
    const outroLen = music.outroLen ?? 8;
    const outroStart = Math.max(0, totalDur - outroLen);
    parts.push(`[${musicIdx}:a]asplit=2[mA][mB]`);
    parts.push(`[mA]atrim=0:${introLen},afade=t=in:d=0.3,afade=t=out:st=${(introLen - 1.5).toFixed(2)}:d=1.5,volume=${vol}[mi]`);
    parts.push(`[mB]atrim=0:${outroLen},afade=t=in:d=1.5,afade=t=out:st=${(outroLen - 2).toFixed(2)}:d=2,volume=${vol},adelay=${Math.round(outroStart * 1000)}|${Math.round(outroStart * 1000)}[mo]`);
    parts.push(`${inLabel}[mi][mo]amix=inputs=3:duration=first:normalize=0[outmix]`);
  } else {
    const fadeOut = Math.max(0.1, totalDur - 2.5).toFixed(2);
    parts.push(`[${musicIdx}:a]volume=${vol},afade=t=in:d=1.2,afade=t=out:st=${fadeOut}:d=2.5[bed]`);
    parts.push(`${inLabel}[bed]amix=inputs=2:duration=first:normalize=0[outmix]`);
  }
  return "[outmix]";
}

// Resolve a segment's `transition` to a dip half-length in seconds, or null for
// no transition. xfade is intentionally rejected (not a freebie — it folds the
// concat spine; see issue #3) rather than silently ignored.
function parseDip(transition, i) {
  if (!transition) return null;
  const type = typeof transition === "string" ? transition : transition.type;
  if (type === "xfade") die(`Segment ${i}: transition "xfade" isn't implemented yet — use "dip", or leave it a hard cut.`);
  if (type !== "dip") die(`Segment ${i}: unknown transition "${type}" — only "dip" is supported.`);
  const dur = typeof transition === "object" && transition.dur != null ? +transition.dur : 0.12;
  return Math.max(0.04, dur);
}

function buildGraph(pack, plan) {
  const out = pack.output || {};
  const W = Number.isInteger(out.width) ? out.width : null;
  const H = Number.isInteger(out.height) ? out.height : null;
  const fps = Number.isInteger(out.fps) ? out.fps : null;

  // Frames must share a canvas size once the timeline switches rolls or uses pip.
  const rolls = new Set(pack.timeline.flatMap((s) => [s.source, s.pip?.source].filter(Boolean)));
  if (rolls.size > 1 && !(W && H)) die("Timeline mixes rolls (switching/pip) — set output.width and output.height so frames share a canvas.");

  // Audio bed must be a real file source.
  const audioKey = pack.audio || null;
  if (audioKey) plan.idxOf(audioKey, "audio bed");

  // Boundary fades. Declick (hygiene) is on unless explicitly disabled. A "dip"
  // transition on a segment is a longer fade straddling the join BEFORE it — so
  // it stamps a fade-in on that segment AND a fade-out on its predecessor.
  const declick = out.declick !== false;
  pack.timeline.forEach((seg, i) => {
    const d = parseDip(seg.transition, i);
    if (d) {
      seg._dipIn = d;
      if (i > 0) pack.timeline[i - 1]._dipOut = d;
    }
  });

  const parts = [];
  const concatLabels = [];
  pack.timeline.forEach((seg, i) => {
    seg._fps = fps;
    buildVideoChain(seg, i, W, H, plan.idxOf, parts);
    buildAudioChain(seg, i, audioKey, plan.idxOf, parts, declick);
    concatLabels.push(`[v${i}][a${i}]`);
  });

  const n = pack.timeline.length;
  parts.push(`${concatLabels.join("")}concat=n=${n}:v=1:a=1[outv][outa]`);

  // Global video escape valve: opaque filter on the whole concatenated picture.
  let vMap = "[outv]";
  if (out.rawVideoFilter) { parts.push(`[outv]${out.rawVideoFilter}[outvf]`); vMap = "[outvf]"; }

  // Audio polish (e.g. WARM = volume=7dB,alimiter), applied before music.
  let aMap = "[outa]";
  if (out.audioFilter) { parts.push(`${aMap}${out.audioFilter}[outaf]`); aMap = "[outaf]"; }
  // Global audio escape valve: opaque filter on the spoken mix, before music.
  if (out.rawAudioFilter) { parts.push(`${aMap}${out.rawAudioFilter}[outraf]`); aMap = "[outraf]"; }

  if (out.music) {
    const totalDur = pack.timeline.reduce((s, sg) => s + segOutDur(sg), 0);
    aMap = buildMusicTail(out.music, plan.musicIdx, plan.bookend, totalDur, aMap, parts);
  }

  return { filterComplex: parts.join(";"), vMap, aMap, segments: n, audioKey, multiRoll: rolls.size > 1 };
}

// ---------------------------------------------------------------------------
// Assemble ffmpeg args and run
// ---------------------------------------------------------------------------
function ffmpegArgs(plan, graph, outPath) {
  const args = [];
  for (const fi of plan.ffInputs) {
    if (fi.streamLoop) args.push("-stream_loop", "-1");
    if (fi.loop) args.push("-loop", "1", "-t", String(fi.dur), "-framerate", String(fi.framerate));
    args.push("-i", fi.path);
  }
  args.push(
    "-filter_complex", graph.filterComplex,
    "-map", graph.vMap, "-map", graph.aMap,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "-y", outPath,
  );
  return args;
}

// Surface raw-valve usage on stderr: which fields, how many. Past this line the
// typed vocabulary couldn't express the edit — that's the promote signal.
function warnRawValve(pack) {
  const used = [];
  const segs = (pack.timeline || []).filter((s) => s.rawFilter).length;
  if (segs) used.push(`${segs} segment rawFilter${segs > 1 ? "s" : ""}`);
  if (pack.output?.rawVideoFilter) used.push("output.rawVideoFilter");
  if (pack.output?.rawAudioFilter) used.push("output.rawAudioFilter");
  if (used.length) {
    console.error(`⚠ raw filter valve in use (${used.join(", ")}) — past the typed vocabulary, unvalidated. Reproducible because it's in the pack; promote it to a real field if it recurs.`);
  }
}

// Chapter markers → a YouTube-style sidecar (`<output>.chapters.txt`, one
// "M:SS Title" line per chaptered segment at its cumulative OUTPUT time). Pure
// metadata: it never touches the video graph. Returns the lines (for dry-run
// preview) and writes the file when a path is given.
function buildChapters(pack) {
  const lines = [];
  let t = 0;
  for (const seg of pack.timeline) {
    if (seg.chapter) lines.push(`${fmtTimecode(t)} ${seg.chapter}`);
    t += segOutDur(seg);
  }
  return lines;
}

function fmtTimecode(t) {
  const s = Math.floor(t % 60), m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    console.log("Usage: node render.js <edit-pack.json> [--out <file.mp4>] [--dry-run]");
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const packPath = resolve(argv[0]);
  const dryRun = argv.includes("--dry-run");
  const outFlagIdx = argv.indexOf("--out");
  const outOverride = outFlagIdx !== -1 ? argv[outFlagIdx + 1] : null;

  const pack = loadPack(packPath);

  // Refuse to render an invalid pack — fail fast with located errors.
  const { errors } = await validatePack(pack);
  if (errors.length) die(`Edit pack failed validation:\n  • ${errors.join("\n  • ")}`);

  // The raw valve is ungated — determinism comes from the string living IN the
  // pack, not from a CLI flag — but loud, so an accidental raw string is a
  // conscious choice and the funnel (issue #2) is visible.
  warnRawValve(pack);

  const plan = planInputs(pack, dirname(packPath));
  const graph = buildGraph(pack, plan);

  const outDir = resolve(process.cwd(), "out");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outName = outOverride || pack.output?.filename || "edit.mp4";
  const outPath = isAbsolute(outName) ? outName : join(outDir, outName);
  const args = ffmpegArgs(plan, graph, outPath);

  console.log(`Edit pack : ${packPath}`);
  console.log(`Inputs    : ${plan.ffInputs.map((fi) => fi.path.split("/").pop()).join(", ")}`);
  console.log(`Segments  : ${graph.segments}${graph.audioKey ? `  ·  audio bed: ${graph.audioKey}` : ""}${graph.multiRoll ? "  ·  multi-roll" : ""}`);
  console.log(`Output    : ${outPath}`);

  const chapters = buildChapters(pack);

  if (dryRun) {
    if (chapters.length) console.log(`Chapters  : ${chapters.length} → ${outPath.replace(/\.[^.]+$/, "")}.chapters.txt`);
    console.log("\n--- filter_complex ---\n" + graph.filterComplex);
    process.exit(0);
  }

  if (chapters.length) {
    const chPath = outPath.replace(/\.[^.]+$/, "") + ".chapters.txt";
    writeFileSync(chPath, chapters.join("\n") + "\n");
    console.log(`Chapters  : ${chapters.length} → ${chPath}`);
  }

  const child = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (e) => die(`Failed to launch ffmpeg: ${e.message}`));
  child.on("close", (code) => code === 0 ? console.log(`\n✓ Rendered ${outPath}`) : die(`ffmpeg exited ${code}`));
}

main();

