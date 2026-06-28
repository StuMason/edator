import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// House grade (#6) + motion blur (#11). Both additive: a pack that uses neither
// renders the unchanged graph (covered by goldens). Here we assert the look grade
// string lands on the finished frame and a motion-blurred push oversamples +
// frame-blends, and that neither fires where it shouldn't.

const __dirname = dirname(fileURLToPath(import.meta.url));
const render = resolve(__dirname, "..", "render.js");
const fixturesDir = resolve(__dirname, "fixtures");
const env = { ...process.env, EDATOR_FONT: join(fixturesDir, "font.ttf") };

function graphFor(pack) {
  const r = spawnSync("node", [render, "/dev/stdin", "--dry-run"], { encoding: "utf8", env, input: JSON.stringify(pack) });
  assert.equal(r.status, 0, `dry-run failed:\n${r.stderr}`);
  const marker = "--- filter_complex ---\n";
  return r.stdout.slice(r.stdout.indexOf(marker) + marker.length).trim();
}

const base = {
  version: "1.1",
  sources: { cam: { file: join(fixturesDir, "media/cam.mp4"), fps: 30 }, screen: { file: join(fixturesDir, "media/screen.mp4"), fps: 30 } },
  audio: "screen",
  output: { width: 1280, height: 720, fps: 30, audioFilter: "volume=7dB,alimiter=limit=0.95" },
};

test("a look applies the locked house grade string to the finished frame", () => {
  const g = graphFor({ ...base, timeline: [{ source: "cam", start: 0, end: 6, look: "cold-open" }] });
  assert.ok(g.includes("eq=contrast=1.06:saturation=1.06:brightness=0.012,vignette=PI/4.6"), `cold-open grade missing\n${g}`);
});

test("an unknown look is rejected", () => {
  const r = spawnSync("node", [render, "/dev/stdin", "--dry-run"], { encoding: "utf8", env,
    input: JSON.stringify({ ...base, timeline: [{ source: "cam", start: 0, end: 6, look: "bogus" }] }) });
  assert.notEqual(r.status, 0, "unknown look should fail");
});

test("motionBlur oversamples the push and frame-blends back", () => {
  const g = graphFor({ ...base, timeline: [{ source: "cam", start: 0, end: 6, zoom: "push", motionBlur: true }] });
  assert.ok(/zoompan=[^;]*fps=90/.test(g), `push should oversample to 90fps\n${g}`);
  assert.ok(/tmix=frames=3/.test(g), `expected 3-frame blend\n${g}`);
});

test("a push WITHOUT motionBlur stays at base fps and adds no tmix", () => {
  const g = graphFor({ ...base, timeline: [{ source: "cam", start: 0, end: 6, zoom: "push" }] });
  assert.ok(/zoompan=[^;]*fps=30/.test(g), `push should stay 30fps\n${g}`);
  assert.ok(!g.includes("tmix"), `no blend without motionBlur\n${g}`);
});
