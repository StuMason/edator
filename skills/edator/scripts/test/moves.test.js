import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const render = resolve(__dirname, "..", "render.js");
const media = resolve(__dirname, "fixtures", "media", "cam.mp4");

function packFile(timeline, output = {}, sources = { cam: { file: media } }) {
  const dir = mkdtempSync(join(tmpdir(), "edator-moves-"));
  const p = join(dir, "pack.json");
  writeFileSync(p, JSON.stringify({
    version: "1.1",
    sources, audio: "cam",
    output: { filename: "x.mp4", width: 1280, height: 720, fps: 30, ...output },
    timeline,
  }));
  return p;
}

const run = (pack, extra = []) => spawnSync("node", [render, pack, ...extra], { encoding: "utf8" });
const graph = (pack) => { const r = run(pack, ["--dry-run"]); assert.equal(r.status, 0, r.stderr); return r.stdout; };

// --- speed ---------------------------------------------------------------

test("speed retimes video (setpts) and audio (atempo) together", () => {
  const g = graph(packFile([{ source: "cam", start: 0, end: 10, speed: 2 }]));
  assert.match(g, /setpts=\(PTS-STARTPTS\)\/2/, "video speeds up via setpts");
  assert.match(g, /atempo=2(,|:|\[)/, "audio speeds up via atempo");
});

test("atempo is chained past its 0.5–2.0 limit (4× → 2×·2×)", () => {
  const g = graph(packFile([{ source: "cam", start: 0, end: 12, speed: 4 }]));
  assert.match(g, /atempo=2,atempo=2/, "4× decomposes into two atempo=2 stages");
});

test("a slow-mo segment chains atempo below 0.5 if needed", () => {
  const g = graph(packFile([{ source: "cam", start: 0, end: 4, speed: 0.25 }]));
  assert.match(g, /atempo=0\.5,atempo=0\.5/, "0.25× decomposes into two atempo=0.5 stages");
});

test("speed compresses the segment's output duration (fade-out lands at the real tail)", () => {
  // 10s at 2× = 5s output; declick fade-out should sit at 5 - 0.005 = 4.995
  const g = graph(packFile([{ source: "cam", start: 0, end: 10, speed: 2 }]));
  assert.match(g, /afade=t=out:st=4\.995/, "fade-out uses output-clock duration");
});

// --- animated zoom (push) ------------------------------------------------

test('zoom:"push" produces an animated zoompan (ramps with the output frame), not a static crop', () => {
  // 6s @ 30fps = 180 output frames; z ramps 1.0 → 1.15 over `on/180`.
  const g = graph(packFile([{ source: "cam", start: 0, end: 6, zoom: "push" }]));
  assert.match(g, /zoompan=z='1\+\(1\.15-1\)\*on\/180'/, "zoom ramps with the output frame index");
  assert.match(g, /:s=1280x720:fps=30/, "zoompan re-emits at canvas size + fps");
});

test("animated zoom honours from/to and focus", () => {
  const g = graph(packFile([{ source: "cam", start: 0, end: 6, zoom: { from: 1.0, to: 1.3, x: 0.3, y: 0.5 } }]));
  assert.match(g, /zoompan=z='1\+\(1\.3-1\)\*on\/180'/, "ramps from `from` to `to`");
  assert.match(g, /x='\(iw-iw\/zoom\)\*0\.3':y='\(ih-ih\/zoom\)\*0\.5'/, "focus point is used");
});

test("a static zoom number is still a fixed crop (unchanged behaviour)", () => {
  const g = graph(packFile([{ source: "cam", start: 0, end: 6, zoom: 1.2 }]));
  assert.match(g, /scale=1536:864,crop=1280:720/, "static path unchanged");
  assert.doesNotMatch(g, /zoompan/, "a static zoom never uses zoompan");
});

// --- chapters ------------------------------------------------------------

test("chapters write a YouTube-style sidecar at cumulative output times", () => {
  // segment 0 is 12s @ 4× = 3s output → chapter 1 at 0:00, chapter 2 at 0:03
  const out = join(mkdtempSync(join(tmpdir(), "edator-ch-")), "v.mp4");
  const pack = packFile([
    { source: "cam", start: 0, end: 12, speed: 4, chapter: "Intro" },
    { source: "cam", start: 12, end: 18, chapter: "The build" },
  ]);
  // No --dry-run: the sidecar is written before ffmpeg is spawned. ffmpeg then
  // fails on the empty placeholder media, but the chapters file already exists.
  run(pack, ["--out", out]);
  const chPath = out.replace(/\.[^.]+$/, "") + ".chapters.txt";
  assert.ok(existsSync(chPath), "sidecar written");
  assert.equal(readFileSync(chPath, "utf8"), "0:00 Intro\n0:03 The build\n");
});

test("chapters are reported in a dry-run without writing anything", () => {
  const g = graph(packFile([{ source: "cam", start: 0, end: 6, chapter: "Only" }]));
  assert.match(g, /Chapters\s*: 1 →/, "dry-run reports the chapter count");
});
