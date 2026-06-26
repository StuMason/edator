import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const render = resolve(__dirname, "..", "render.js");
const media = resolve(__dirname, "fixtures", "media", "cam.mp4");

function packFile(timeline, output = {}) {
  const dir = mkdtempSync(join(tmpdir(), "edator-trans-"));
  const p = join(dir, "pack.json");
  writeFileSync(p, JSON.stringify({
    version: "1.1",
    sources: { cam: { file: media } },
    output: { filename: "x.mp4", width: 1280, height: 720, fps: 30, ...output },
    timeline,
  }));
  return p;
}

const graph = (pack) => {
  const r = spawnSync("node", [render, pack, "--dry-run"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.slice(r.stdout.indexOf("--- filter_complex ---"));
};

const two = [{ source: "cam", start: 0, end: 6 }, { source: "cam", start: 6, end: 12 }];

test("declick is on by default — every audio segment gets a 5ms boundary fade", () => {
  const g = graph(packFile(two));
  assert.match(g, /afade=t=in:d=0\.005/, "should fade in at the splice");
  assert.match(g, /afade=t=out:st=[\d.]+:d=0\.005/, "should fade out at the splice");
});

test("declick:false removes the boundary fades", () => {
  const g = graph(packFile(two, { declick: false }));
  assert.doesNotMatch(g, /afade/, "no boundary fades when declick is disabled");
});

test('transition:"dip" dips both video and audio to black around the join', () => {
  // segment 1 carries the dip → seg0 fades OUT (video+audio), seg1 fades IN
  const g = graph(packFile([
    { source: "cam", start: 0, end: 6 },
    { source: "cam", start: 6, end: 12, transition: "dip" },
  ]));
  assert.match(g, /fade=t=out:[^[]*d=0\.12[^a]/, "video dips out before the join");
  assert.match(g, /fade=t=in:st=0:d=0\.12/, "video dips in after the join");
  assert.match(g, /afade=t=in:d=0\.12/, "audio dips in after the join");
});

test('transition object honours a custom dur', () => {
  const g = graph(packFile([
    { source: "cam", start: 0, end: 6 },
    { source: "cam", start: 6, end: 12, transition: { type: "dip", dur: 0.4 } },
  ]));
  assert.match(g, /fade=t=in:st=0:d=0\.4/, "custom dip length is used");
});

test("xfade is rejected clearly, not silently ignored", () => {
  const r = spawnSync("node", [render, packFile([
    { source: "cam", start: 0, end: 6 },
    { source: "cam", start: 6, end: 12, transition: { type: "xfade" } },
  ]), "--dry-run"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  // Rejected at whichever layer fires first: the schema (ajv, if installed) lists
  // "dip" as the only allowed transition; the renderer names xfade outright.
  assert.match(r.stderr, /xfade.*isn't implemented|allowed values \(dip\)/, "should reject xfade, not ignore it");
});
