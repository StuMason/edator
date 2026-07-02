#!/usr/bin/env node
/**
 * Golden-pack matrix test — renders every segment FEATURE against every source
 * KIND (video / image still) on tiny synthetic footage and asserts the output
 * is the shape the pack promised.
 *
 * Why: features tend to get tested only along the path they shipped for.
 * `split` worked for screen mains for weeks, then the first image main
 * produced a 138-second short from a 41-second pack. Duration assertions on a
 * full combination matrix catch that class of bug in seconds.
 *
 *   node scripts/test-matrix.mjs          # run all cases
 *   node scripts/test-matrix.mjs split    # only cases whose name matches
 *
 * Sources are generated with lavfi (nothing checked in); everything lands in a
 * temp dir and is deleted on success. Exit code = number of failures.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const FILTER = process.argv[2] || "";
const work = mkdtempSync(join(tmpdir(), "edator-matrix-"));
const sh = (bin, args) => execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();

// ── synthetic sources (10s is plenty; every case cuts a 2s window) ───────────
console.log("▸ generating synthetic sources…");
sh("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi",
  "-i", "sine=frequency=440:sample_rate=48000", "-t", "10", "-c:v", "libx264", "-preset", "ultrafast",
  "-c:a", "aac", "-y", join(work, "main.mp4")]);
sh("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "smptebars=size=320x180:rate=30", "-t", "10",
  "-c:v", "libx264", "-preset", "ultrafast", "-y", join(work, "alt.mp4")]);
sh("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-frames:v", "1",
  "-y", join(work, "card.png")]);

const SRC = {
  main: { file: "main.mp4", fps: 30, duration: 10 },
  alt: { file: "alt.mp4", fps: 30, duration: 10 },
  card: { file: "card.png", image: true },
};
const landscape = { width: 320, height: 180, fps: 30 };
const vertical = { width: 180, height: 320, fps: 30 };

// Each case: name, output geometry, timeline, expected output duration.
const CASES = [
  { name: "plain-cut", out: landscape, tl: [{ source: "main", start: 2, end: 4 }], dur: 2 },
  { name: "zoom-static", out: landscape, tl: [{ source: "main", start: 2, end: 4, zoom: { scale: 1.3, x: 0.4, y: 0.4 } }], dur: 2 },
  { name: "zoom-push", out: landscape, tl: [{ source: "main", start: 2, end: 4, zoom: "push" }], dur: 2 },
  { name: "speed-2x", out: landscape, tl: [{ source: "main", start: 2, end: 6, speed: 2 }], dur: 2 },
  { name: "pip-video", out: landscape, tl: [{ source: "main", start: 2, end: 4, pip: { source: "alt", corner: "br" } }], dur: 2 },
  { name: "image-plain", out: landscape, tl: [{ source: "card", start: 2, end: 4 }], dur: 2 },
  { name: "image-pip", out: landscape, tl: [{ source: "card", start: 2, end: 4, pip: { source: "alt", corner: "br" } }], dur: 2 },
  { name: "image-push", out: landscape, tl: [{ source: "card", start: 2, end: 4, zoom: { from: 1, to: 1.1 } }], dur: 2 },
  { name: "split-video-main", out: vertical, tl: [{ source: "main", start: 2, end: 4, split: true, pip: { source: "alt" }, reframe: { mode: "cover", x: 0.5, y: 0.4 } }], dur: 2 },
  { name: "split-image-main", out: vertical, tl: [{ source: "card", start: 2, end: 4, split: true, pip: { source: "alt" }, reframe: { mode: "cover", x: 0.5, y: 0.4 } }], dur: 2 },
  { name: "reframe-cover", out: vertical, tl: [{ source: "main", start: 2, end: 4, reframe: { mode: "cover", x: 0.5, y: 0.4 } }], dur: 2 },
  { name: "bleep", out: landscape, tl: [{ source: "main", start: 2, end: 4, bleeps: [{ start: 2.5, end: 2.9 }] }], dur: 2 },
  { name: "dip-join", out: landscape, tl: [{ source: "main", start: 2, end: 4 }, { source: "main", start: 6, end: 8, transition: "dip" }], dur: 4 },
  { name: "speed+image+dip", out: landscape, tl: [{ source: "main", start: 2, end: 6, speed: 2 }, { source: "card", start: 6, end: 8, transition: "dip" }], dur: 4 },
];

let failures = 0;
const results = [];
for (const c of CASES) {
  if (FILTER && !c.name.includes(FILTER)) continue;
  const pack = { version: "1.1", sources: SRC, audio: "main",
    output: { filename: `${c.name}.mp4`, ...c.out }, timeline: c.tl };
  const packPath = join(work, `${c.name}.json`);
  writeFileSync(packPath, JSON.stringify(pack, null, 2));
  const outPath = join(work, `${c.name}.mp4`);
  try {
    sh("node", [join(SCRIPTS, "validate.js"), packPath]);
    sh("node", [join(SCRIPTS, "render.js"), packPath, "--out", outPath]);
    const probe = JSON.parse(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-show_entries", "stream=codec_type", "-of", "json", outPath]));
    const dur = +probe.format.duration;
    const kinds = probe.streams.map((s) => s.codec_type).sort().join("+");
    // dips pad the join a touch; allow 0.35s total slack, hard-fail beyond it.
    const slack = c.tl.some((s) => s.transition) ? 0.35 : 0.15;
    if (Math.abs(dur - c.dur) > slack) throw new Error(`duration ${dur.toFixed(2)}s, expected ~${c.dur}s`);
    if (kinds !== "audio+video") throw new Error(`streams ${kinds}, expected audio+video`);
    results.push(`  ✓ ${c.name.padEnd(18)} ${dur.toFixed(2)}s`);
  } catch (e) {
    failures++;
    const msg = (e.stderr?.toString() || e.message || "").split("\n").filter(Boolean).slice(-2).join(" · ");
    results.push(`  ✗ ${c.name.padEnd(18)} ${msg}`);
  }
}
console.log(results.join("\n"));
if (!failures) rmSync(work, { recursive: true, force: true });
else console.log(`\nartifacts kept for inspection: ${work}`);
console.log(failures ? `✗ ${failures} case(s) failed` : "✓ matrix clean");
process.exit(failures);
