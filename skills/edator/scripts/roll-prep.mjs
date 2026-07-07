#!/usr/bin/env node
/**
 * roll-prep.mjs — ingest a "roll" recorder take into pipeline-ready sources.
 *
 * The Tauri "roll" app writes a folder per take: screen.mp4, camera.mp4 (silent),
 * mic.m4a (SEPARATE track), manifest.json (per-stream firstPTS + sync offsets +
 * display geometry) and metadata.jsonl (cursor/click/scroll events). Two things
 * always need fixing before the renderer can cut frame-accurately:
 *
 *   1. A roll is sometimes VARIABLE frame rate (delta-encoded screen, or a camera
 *      that drifted off 30) — which breaks frame-accurate trims. We detect VFR
 *      per roll and CFR-normalise only the ones that need it (clean rolls are
 *      referenced in place, no needless re-encode).
 *   2. The mic is a separate track recorded a few tens of ms after the screen
 *      clock (manifest.micSyncOffsetMs). We delay it onto the screen clock so the
 *      renderer's audio bed lines up with the picture.
 *
 * Output: <out>/<stem>.screen.mp4 (or a note that the original is already CFR),
 * <out>/<stem>.camera.mp4, <out>/<stem>.mic.m4a — plus a ready-to-paste `sources`
 * block for the edit pack.
 *
 *   node roll-prep.mjs <roll-dir> --stem <name> [--out workspace/recordings] [--fps 30]
 *
 * Idempotent: skips a normalise whose output already exists (--force to redo).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { resolve, join, isAbsolute, relative, dirname } from "node:path";

const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26 });

const argv = process.argv.slice(2);
const rollDir = argv.find((a) => !a.startsWith("--"));
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const FORCE = argv.includes("--force");
if (!rollDir || !existsSync(rollDir)) die("usage: roll-prep.mjs <roll-dir> --stem <name> [--out dir] [--fps 30] [--force]");

const SRC = resolve(rollDir);
const stem = opt("stem", null) || die("--stem <name> is required (the pack/source basename)");
const OUT = resolve(opt("out", "workspace/recordings"));
const FPS = +opt("fps", 30);
mkdirSync(OUT, { recursive: true });

const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));

// --- VFR detection: a roll is VFR if its average frame rate strays from nominal.
// avg_frame_rate is total_frames / duration; r_frame_rate is the nominal base.
// Delta-encoded screen reads e.g. avg 7.92 of nominal 60; a drifting cam 29.27/30.
function avgFps(file) {
  const r = sh("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate", "-of", "default=noprint_wrappers=1:nokey=1", file]);
  const [n, d] = (r.stdout || "0/1").trim().split("/").map(Number);
  return d ? n / d : 0;
}
const isVfr = (file) => { const a = avgFps(file); return Math.abs(a - FPS) / FPS > 0.02; };

function cfrNormalise(inFile, outFile, crf) {
  if (existsSync(outFile) && !FORCE) return `(exists) ${outFile}`;
  const r = sh("ffmpeg", ["-y", "-v", "error", "-fflags", "+genpts", "-i", inFile,
    "-vsync", "cfr", "-r", String(FPS), "-c:v", "libx264", "-preset", "medium",
    "-crf", String(crf), "-pix_fmt", "yuv420p", "-an", outFile]);
  if (r.status !== 0) die(`ffmpeg CFR normalise failed for ${inFile}: ${(r.stderr || "").slice(0, 200)}`);
  return outFile;
}

// link a clean roll in place rather than re-encode it
function linkSrc(name, dst) {
  if (existsSync(dst)) { if (!FORCE) return dst; rmSync(dst); }
  symlinkSync(join(SRC, name), dst);
  return dst;
}

const result = { screen: null, camera: null, mic: null };

// screen: CFR-normalise if VFR, else symlink (screen content compresses cheaply at crf18)
const screenSrc = join(SRC, "screen.mp4");
if (isVfr(screenSrc)) { console.log(`· screen is VFR → CFR-normalising`); result.screen = cfrNormalise(screenSrc, join(OUT, `${stem}.screen.mp4`), 18); }
else { console.log(`· screen already CFR → referencing in place`); result.screen = linkSrc("screen.mp4", join(OUT, `${stem}.screen.mp4`)); }

// camera: same logic, crf20 (face cam tolerates a touch more compression)
const cameraSrc = join(SRC, "camera.mp4");
if (isVfr(cameraSrc)) { console.log(`· camera is VFR → CFR-normalising`); result.camera = cfrNormalise(cameraSrc, join(OUT, `${stem}.camera.mp4`), 20); }
else { console.log(`· camera already CFR → referencing in place`); result.camera = linkSrc("camera.mp4", join(OUT, `${stem}.camera.mp4`)); }

// mic: delay onto the screen clock by micSyncOffsetMs (the only sync that matters;
// cam offset is sub-frame). adelay takes ms.
const micOff = +(manifest.micSyncOffsetMs || 0);
const micOut = join(OUT, `${stem}.mic.m4a`);
if (!existsSync(micOut) || FORCE) {
  const r = sh("ffmpeg", ["-y", "-v", "error", "-i", join(SRC, "mic.m4a"), "-af", `adelay=${micOff.toFixed(2)}`, "-c:a", "aac", "-b:a", "192k", micOut]);
  if (r.status !== 0) die(`mic sync failed: ${(r.stderr || "").slice(0, 200)}`);
}
result.mic = micOut;
console.log(`· mic delayed +${micOff.toFixed(1)}ms onto the screen clock`);

// emit a ready-to-paste sources block (paths relative to a pack in workspace/packs/)
const rel = (p) => `../recordings/${p.replace(OUT + "/", "")}`;
const dur = +(manifest.durationMs / 1000).toFixed(2);
console.log(`\n— paste into pack.sources —`);
console.log(JSON.stringify({
  screen: { file: rel(result.screen), fps: FPS, duration: dur },
  cam: { file: rel(result.camera), fps: FPS, duration: dur },
  mic: { file: rel(result.mic), duration: dur },
}, null, 2));
console.log(`\n✓ roll-prep done — stem "${stem}", display ${manifest.display?.w}×${manifest.display?.h} @ x${manifest.display?.x}`);
