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
 *   - captions     `captions:[{text,start,end}]` — neutral burned-in "plain" captions
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
import { segOutDur, segAudioKey } from "./timeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const even = (n) => Math.max(2, Math.round(n / 2) * 2);   // h264 needs even dimensions

// Fonts. drawtext needs a real TTF/OTF path, which differs per OS. Resolve a
// bold sans for plain captions from per-platform candidates, first match wins.
// Override with EDATOR_FONT. Captions are the only thing that needs a font, so
// resolution is lazy: a pack with no captions renders even where no font is found.
const FONT_CANDIDATES = {
  darwin: ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"],
  linux: ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"],
  win32: ["C:\\Windows\\Fonts\\arialbd.ttf", "C:\\Windows\\Fonts\\arial.ttf"],
};
function resolveFont(envVar, candidatesByOs) {
  if (process.env[envVar]) return process.env[envVar];   // trust the override; validated lazily
  for (const c of candidatesByOs[platform()] || []) if (existsSync(c)) return c;
  return null; // nothing found — only fatal if a caption actually needs it (see needFont)
}
const FONT = resolveFont("EDATOR_FONT", FONT_CANDIDATES);
const needFont = () => {
  if (!FONT) die(`No bold sans font found for captions on ${platform()}. Set EDATOR_FONT to a .ttf/.otf file.`);
  if (!existsSync(FONT)) die(`EDATOR_FONT points at a font that doesn't exist: ${FONT}`);
  return FONT;
};

// Named house grades (POLISH-BACKLOG #6). A `look` locks ONE reproducible grade
// for a styled beat, instead of hand-tuning per-segment rawFilter that drifts cut
// to cut. "same pack → same video" applied to colour. Screen-shares stay ungraded
// by rule — only put a look on a face/cold-open/punch beat. cold-open is the
// canonical house open grade (a contrast/sat lift + vignette).
const LOOKS = {
  "cold-open": "eq=contrast=1.06:saturation=1.06:brightness=0.012,vignette=PI/4.6",
  "punch": "eq=contrast=1.10:saturation=1.12:brightness=0.010,vignette=PI/5",
  "noir": "eq=contrast=1.14:saturation=0.55:brightness=-0.005,vignette=PI/4.2",
  "warm": "eq=contrast=1.04:saturation=1.10:gamma_r=1.03:gamma_b=0.98",
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

// Build a drawtext filter for one caption, timed relative to its segment start.
// Only the neutral "plain" caption is drawn here — branded/animated overlays
// (signed bubbles, eyebrow labels, lower-thirds) are a downstream-compositor
// concern, deliberately kept out of this generic renderer.
function drawtext(cap, segStart, Wpx, Hpx, speed = 1) {
  const H = Hpx || 720;
  // Captions are authored in source-time; a sped-up segment compresses the
  // output clock, so the on-screen window divides by the speed factor.
  const a = ((cap.start - segStart) / speed).toFixed(3);
  const b = ((cap.end - segStart) / speed).toFixed(3);
  const en = `enable=between(t\\,${a}\\,${b})`;

  // plain caption (neutral labels / subtitles)
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

// Animated push (Ken Burns): ramp the apparent zoom from `from` to `to` across
// the segment. crop CAN'T do this — its w/h are evaluated once at init, not per
// frame — so zoompan is the right tool: it recomputes the view every output
// frame. z grows linearly with the output-frame index `on`; x/y keep the focus
// point fixed as it zooms; d=1 emits one output frame per input frame (it's
// video, not a held still). dur is the segment's OUTPUT duration, fps its rate.
function pushFilters(z, W, H, dur, fps, motionBlur) {
  const from = z.from != null ? z.from : 1.0;
  const to = z.to != null ? z.to : 1.15;
  const fx = z.x != null ? z.x : 0.5;
  const fy = z.y != null ? z.y : 0.34;
  const f = Number.isInteger(fps) ? fps : 30;
  // Motion blur (POLISH-BACKLOG #11): a fast push at 30fps can strobe/judder.
  // Render the move at OVER× the frame rate, blend each group of OVER frames
  // (tmix), then decimate back to f — true synthetic motion blur on the move,
  // with NO permanent softening of held detail. Off → sub=1, byte-identical path.
  const sub = motionBlur ? 3 : 1;
  const fZoom = f * sub;                         // zoompan's internal (oversampled) rate
  const N = Math.max(1, Math.round(dur * fZoom));   // frames over the segment at that rate
  const zexpr = `${from}+(${to}-${from})*on/${N}`;
  // zoompan rounds the crop window to whole INPUT pixels each frame, so a slow
  // push moves sub-pixel/frame and visibly "sticks then jumps" (jitter). Cure:
  // supersample the frame up first, so 1px of rounding is a fraction of an output
  // pixel. SS=4 makes the shake imperceptible; it only runs on push segments.
  const SS = 4;
  // d=sub emits `sub` output frames per INPUT frame, each at its own zoom step, so
  // oversampling to fZoom preserves the segment's DURATION (d=1 would keep only the
  // 30 source frames and play 3× fast). tmix then blends each group → motion blur.
  const out = [
    `scale=${even(W * SS)}:${even(H * SS)}:flags=bicubic`,
    `zoompan=z='${zexpr}':x='(iw-iw/zoom)*${fx}':y='(ih-ih/zoom)*${fy}':d=${sub}:s=${W}x${H}:fps=${fZoom}`,
  ];
  if (motionBlur) out.push(`tmix=frames=${sub}:weights='${Array(sub).fill(1).join(" ")}'`, `fps=${f}`);
  return out;
}

// Is this zoom an animated push (push shorthand or from/to) vs a static crop?
const isPush = (z) => z === "push" || (typeof z === "object" && (z.from != null || z.to != null));

// How a source frame fills the canvas when their aspect ratios differ.
//   contain (default) — letterbox: fit the whole frame, pad the gaps. Unchanged
//     legacy behaviour, so every existing pack renders identically.
//   cover — fill the frame and crop the overflow at a focus point (x,y in 0..1).
//     This is what vertical (9:16) clips need: a 16:9 roll cover-crops to a
//     vertical slice, face-centred for cam, the active region for screen.
// `reframe` is a string ("cover") or {mode,x,y}. Returns the scale/crop|pad
// filter pair; the caller prefixes the input label to the first entry.
function fitChain(reframe, W, H) {
  const mode = typeof reframe === "string" ? reframe : reframe?.mode;
  if (mode === "cover") {
    const fx = typeof reframe === "object" && reframe.x != null ? reframe.x : 0.5;
    const fy = typeof reframe === "object" && reframe.y != null ? reframe.y : 0.5;
    return [
      `scale=${W}:${H}:force_original_aspect_ratio=increase`,
      `crop=${W}:${H}:(iw-${W})*${fx}:(ih-${H})*${fy}`,
    ];
  }
  return [
    `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`,
  ];
}

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
    const fit = fitChain(seg.reframe, W, H);
    base.push(`[${seg._vIdx}:v]${fit[0]}`, ...fit.slice(1));
    if (seg.zoom && isPush(seg.zoom)) base.push(...pushFilters(seg.zoom === "push" ? {} : seg.zoom, W, H, segOutDur(seg), seg._fps, seg.motionBlur));   // Ken Burns on a still
    if (wantFps) base.push(`fps=${seg._fps}`);
    base.push("setsar=1");
  } else {
    base.push(`[${seg._vIdx}:v]trim=start=${seg.start}:end=${seg.end}`, setpts);
    if (seg.zoom && isPush(seg.zoom) && wantScale) {
      // Animated push: normalise to canvas, then ramp the zoom over the segment.
      base.push(...fitChain(seg.reframe, W, H));
      base.push(...pushFilters(seg.zoom === "push" ? {} : seg.zoom, W, H, segOutDur(seg), seg._fps, seg.motionBlur));
    } else if (seg.zoom && wantScale) {
      // Static punch-in: scale up then crop back to canvas. zoom = number, or
      // {scale,x,y} where x/y are focus points 0..1 (y defaults high for the face).
      const z = typeof seg.zoom === "number" ? seg.zoom : (seg.zoom.scale || 1.2);
      const fx = typeof seg.zoom === "object" && seg.zoom.x != null ? seg.zoom.x : 0.5;
      const fy = typeof seg.zoom === "object" && seg.zoom.y != null ? seg.zoom.y : 0.34;
      const sW = even(W * z), sH = even(H * z);
      base.push(`scale=${sW}:${sH}`, `crop=${W}:${H}:${Math.round((sW - W) * fx)}:${Math.round((sH - H) * fy)}`);
    } else if (wantScale) {
      base.push(...fitChain(seg.reframe, W, H));
    }
    if (wantFps) base.push(`fps=${seg._fps}`);
    base.push("setsar=1");
  }

  // Captions, timed in source-time like the cut.
  const caps = Array.isArray(seg.captions) ? seg.captions : [];
  const capChain = caps
    .map((c) => drawtext(c, seg.start, W, H, speed))
    .join(",");

  // Dip-to-black transition: fade this segment in from black at its head, and/or
  // out to black at its tail (stamped when a neighbour requests a dip). It's a
  // trailing fade on the finished frame, so the concat spine is untouched.
  // Timing is OUTPUT-clock (speed-aware), so the dip lands at the real tail.
  const segDur = segOutDur(seg);
  const tail = [];
  if (seg._dipIn) tail.push(`fade=t=in:st=0:d=${seg._dipIn}`);
  if (seg._dipOut) tail.push(`fade=t=out:st=${(segDur - seg._dipOut).toFixed(3)}:d=${seg._dipOut}`);
  // House grade (POLISH-BACKLOG #6): a named, locked look applied to this beat's
  // finished frame. Before rawFilter so a one-off can still layer on top.
  if (seg.look) tail.push(LOOKS[seg.look] || die(`Segment ${i}: unknown look "${seg.look}" — known: ${Object.keys(LOOKS).join(", ")}`));
  // Escape valve: an opaque, unvalidated filter string, spliced in as the LAST
  // transform on this segment's finished frame (after scale/zoom/pip/captions/
  // transition). Frames in → frames out, no label refs. See issue #2.
  if (seg.rawFilter) tail.push(seg.rawFilter);
  // Where the composited frame lands before the optional trailing transforms.
  const vTerm = tail.length ? `[vpre${i}]` : `[v${i}]`;

  if (seg.split && wantScale && seg.pip) {
    // 50:50 vertical STACK: the main source (screen) fills a top band at full
    // width; the pip's roll (the face cam) cover-crops the bottom band. The gap
    // between them is the near-black "seam" the dressing drops captions into.
    // Used when a 16:9 screen-share can't be cropped to 9:16 without losing it.
    const camIdx = idxOf(seg.pip.source, `Segment ${i} split`);
    const sH = even(W * 9 / 16);                 // screen band height at full width
    const sY = Math.round(H * 0.09);             // top band offset (below top chrome)
    const seamH = Math.round(H * 0.085);         // the caption seam
    const cY = sY + sH + seamH;                  // bottom (face) band offset
    const cH = even(H - cY - Math.round(H * 0.075));
    const rf = typeof seg.reframe === "object" ? seg.reframe : {};
    const fx = rf.x != null ? rf.x : 0.5, fy = rf.y != null ? rf.y : 0.42;
    const f = seg._fps || 30, dur = segOutDur(seg).toFixed(3);
    const ovOut = capChain ? `[ov${i}]` : vTerm;
    parts.push(`[${seg._vIdx}:v]trim=start=${seg.start}:end=${seg.end},${setpts},scale=${W}:${sH},setsar=1[top${i}]`);
    parts.push(`[${camIdx}:v]trim=start=${seg.start}:end=${seg.end},${setpts},scale=${W}:${cH}:force_original_aspect_ratio=increase,crop=${W}:${cH}:(iw-${W})*${fx}:(ih-${cH})*${fy},setsar=1[bot${i}]`);
    parts.push(`color=c=0x0a0c10:s=${W}x${H}:r=${f}:d=${dur},setsar=1[cv${i}]`);
    parts.push(`[cv${i}][top${i}]overlay=0:${sY}:eof_action=repeat[ct${i}]`);
    parts.push(`[ct${i}][bot${i}]overlay=0:${cY}:eof_action=repeat${wantFps ? `,fps=${seg._fps}` : ""}${ovOut}`);
    if (capChain) parts.push(`[ov${i}]${capChain}${vTerm}`);
  } else if (seg.pip) {
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

  // Bleeps: censor word(s). Authored in source-time like captions; here they're
  // projected to the segment's OUTPUT clock (÷ speed), the speech muted across
  // each window, and a 1kHz tone dropped in its place. No bleeps → one clean line.
  const bleeps = Array.isArray(seg.bleeps) ? seg.bleeps : [];
  const term = bleeps.length ? `[araw${i}]` : `[a${i}]`;
  parts.push(`[${aIdx}:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS${atempo}${fx}${term}`);
  if (!bleeps.length) return;

  const windows = bleeps
    .map((b) => ({ a: +((b.start - seg.start) / speed).toFixed(3), b: +((b.end - seg.start) / speed).toFixed(3) }))
    .filter((w) => w.b > w.a);
  // Mute the speech across every window (volume=0 only while `enable` is true).
  const enable = windows.map((w) => `between(t\\,${w.a}\\,${w.b})`).join("+");
  parts.push(`${term}volume=0:enable=${enable}[amute${i}]`);
  // One 1kHz tone per window, delayed to land exactly over the muted word.
  const tones = windows.map((w, k) => {
    const dur = (w.b - w.a).toFixed(3), off = Math.round(w.a * 1000);
    parts.push(`sine=frequency=1000:sample_rate=48000:duration=${dur},adelay=${off}|${off},aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000,volume=0.5[bz${i}_${k}]`);
    return `[bz${i}_${k}]`;
  });
  parts.push(`[amute${i}]${tones.join("")}amix=inputs=${1 + tones.length}:duration=first:normalize=0[a${i}]`);
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
    if (music.duck) {
      // Sidechain-duck the bed under speech (POLISH-BACKLOG #10). The instant a
      // bed meets a talking beat it fights the voice; ducking pulls it ~6-9 dB
      // while speech is present and swells it back in the gaps. Split the spoken
      // mix: one copy feeds the final amix, one is the sidechain key.
      parts.push(`[${musicIdx}:a]volume=${vol},afade=t=in:d=1.2,afade=t=out:st=${fadeOut}:d=2.5[bedpre]`);
      parts.push(`${inLabel}asplit=2[spmix][spkey]`);
      parts.push(`[bedpre][spkey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[bed]`);
      parts.push(`[spmix][bed]amix=inputs=2:duration=first:normalize=0[outmix]`);
    } else {
      parts.push(`[${musicIdx}:a]volume=${vol},afade=t=in:d=1.2,afade=t=out:st=${fadeOut}:d=2.5[bed]`);
      parts.push(`${inLabel}[bed]amix=inputs=2:duration=first:normalize=0[outmix]`);
    }
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

// J-cuts & L-cuts — the single most "pro" dialogue move (POLISH-BACKLOG #1).
//
// A hard cut welds a segment's audio to its own picture. Real talking-head edits
// let audio LEAD or TRAIL its picture across a join so cuts feel like conversation
// instead of slides:
//   audioLead  (J-cut) — this segment's audio starts N seconds EARLY, heard under
//                        the PREVIOUS segment's picture (the next voice arrives first).
//   audioTrail (L-cut) — this segment's audio runs N seconds LATE, heard under the
//                        NEXT segment's picture (this voice lingers as we cut away).
//
// Implementation is ADDITIVE so the default graph is byte-identical (the golden
// snapshots only change when a pack actually uses a lead/trail). The concat spine
// stays as-is; we operate on the post-concat [outa]: MUTE the spine across each
// bleed window, then mix in the bled audio — the L extra seconds of source —
// adelay'd to land at the right output time. On a two-roll record this is free
// coverage: the face mic keeps talking under a screen push-in.
//
// Returns the (possibly new) audio map label.
function applyJLcuts(pack, plan, aMap, parts) {
  const tl = pack.timeline;
  const starts = [];
  let t = 0;
  for (const s of tl) { starts.push(t); t += segOutDur(s); }
  const last = tl.length - 1;

  const bleeds = [];   // { aIdx, s, e, speed, at }  — source [s,e) at output time `at`
  const mutes = [];    // { from, to }               — spine windows to silence
  tl.forEach((seg, i) => {
    const sp = seg.speed || 1;
    const aKey = segAudioKey(seg, pack);
    const lead = i > 0 && seg.audioLead ? Math.min(+seg.audioLead, starts[i], seg.start / sp) : 0;
    const trail = i < last && seg.audioTrail ? Math.min(+seg.audioTrail, segOutDur(tl[i + 1])) : 0;
    if (lead > 0.001) {
      const aIdx = plan.idxOf(aKey, `Segment ${i} audioLead`);
      const at = +(starts[i] - lead).toFixed(3);
      bleeds.push({ aIdx, s: +(seg.start - lead * sp).toFixed(3), e: seg.start, speed: sp, at });
      mutes.push({ from: at, to: +starts[i].toFixed(3) });
    }
    if (trail > 0.001) {
      const aIdx = plan.idxOf(aKey, `Segment ${i} audioTrail`);
      const at = +(starts[i] + segOutDur(seg)).toFixed(3);
      bleeds.push({ aIdx, s: seg.end, e: +(seg.end + trail * sp).toFixed(3), speed: sp, at });
      mutes.push({ from: at, to: +(at + trail).toFixed(3) });
    }
  });
  if (!bleeds.length) return aMap;

  // Silence the spine under every bleed (continuous audio replaces it, so no click).
  const enable = mutes.map((m) => `between(t\\,${m.from}\\,${m.to})`).join("+");
  parts.push(`${aMap}volume=0:enable='${enable}'[jlmute]`);

  const labels = [];
  bleeds.forEach((b, k) => {
    const atempo = b.speed !== 1 ? "," + atempoChain(b.speed).join(",") : "";
    const outDur = (b.e - b.s) / b.speed;
    const fadeOut = Math.max(0.001, outDur - 0.005).toFixed(3);
    const ms = Math.round(b.at * 1000);
    parts.push(`[${b.aIdx}:a]atrim=start=${b.s}:end=${b.e},asetpts=PTS-STARTPTS${atempo},` +
      `afade=t=in:d=0.005,afade=t=out:st=${fadeOut}:d=0.005,adelay=${ms}|${ms}[jl${k}]`);
    labels.push(`[jl${k}]`);
  });
  parts.push(`[jlmute]${labels.join("")}amix=inputs=${1 + labels.length}:duration=first:normalize=0[jlmix]`);
  return "[jlmix]";
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

  // J/L cuts: bleed segment audio across joins (additive — no-op without
  // audioLead/audioTrail, so the default graph is unchanged). Runs FIRST so the
  // warm chain + any music apply to the whole mix, bleeds included.
  let aMap = applyJLcuts(pack, plan, "[outa]", parts);

  // Opt-in 80 Hz high-pass (POLISH-BACKLOG #9). NOT part of the locked WARM chain
  // — it's off by default. `out.highpass: true` (→80 Hz) or a number sets the
  // corner. Removes desk thump / plosive rumble / AC hum below the voice with no
  // audible effect on tone. A/B it against raw WARM before committing per video.
  if (out.highpass) {
    const hz = out.highpass === true ? 80 : +out.highpass;
    parts.push(`${aMap}highpass=f=${hz}[outhp]`); aMap = "[outhp]";
  }

  // Audio polish (e.g. WARM = volume=7dB,alimiter), applied before music.
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
    // Tag the colour pipeline explicitly. Without these a player GUESSES the
    // primaries/transfer/range and guesses wrong — graded blacks crush or wash
    // depending on the viewer's machine. bt709 + limited range is the correct,
    // universal flag set for SDR HD delivery, one class of "looks slightly off on
    // his machine" bug gone. (POLISH-BACKLOG #7). The encode flags alone only
    // land the matrix + range reliably, so the h264_metadata bitstream filter
    // pins primaries + transfer into the VUI too (1 = bt709, full_range_flag 0 =
    // limited). Bitstream-level, so the filter_complex is untouched.
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0",
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

  // Output path resolution. An explicit relative `--out` is resolved against the
  // CURRENT WORKING DIRECTORY (what the caller means) — NOT the ./out fallback dir,
  // which only homes the *default* filename. (The old code joined an explicit
  // relative --out onto ./out and silently wrote to a bogus, often-missing path.)
  const outDir = resolve(process.cwd(), "out");
  const outName = pack.output?.filename || "edit.mp4";
  const outPath = outOverride
    ? (isAbsolute(outOverride) ? outOverride : resolve(process.cwd(), outOverride))
    : (isAbsolute(outName) ? outName : join(outDir, outName));
  const outParent = dirname(outPath);
  if (!existsSync(outParent)) mkdirSync(outParent, { recursive: true });
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

