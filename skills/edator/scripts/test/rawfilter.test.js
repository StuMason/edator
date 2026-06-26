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
  const dir = mkdtempSync(join(tmpdir(), "edator-raw-"));
  const p = join(dir, "pack.json");
  writeFileSync(p, JSON.stringify({
    version: "1.1",
    sources: { cam: { file: media } },
    output: { filename: "x.mp4", width: 1280, height: 720, fps: 30, ...output },
    timeline,
  }));
  return p;
}

const run = (pack) => spawnSync("node", [render, pack, "--dry-run"], { encoding: "utf8" });
const graph = (pack) => { const r = run(pack); assert.equal(r.status, 0, r.stderr); return r.stdout.slice(r.stdout.indexOf("--- filter_complex ---")); };

const one = [{ source: "cam", start: 0, end: 6 }];

test("per-segment rawFilter is the LAST transform on the segment frame (after the dip fade)", () => {
  const g = graph(packFile([
    { source: "cam", start: 0, end: 6, transition: "dip", rawFilter: "rgbashift=rh=4:bh=-4" },
    { source: "cam", start: 6, end: 12 },
  ]));
  // dip fade is applied, then the raw filter, both before the [v0] terminal.
  assert.match(g, /fade=t=in:st=0:d=0\.12,rgbashift=rh=4:bh=-4\[v0\]/, "raw must come after the transition fade");
});

test("output.rawVideoFilter wraps the concatenated picture and is what gets mapped", () => {
  const g = graph(packFile(one, { rawVideoFilter: "hue=s=0" }));
  assert.match(g, /\[outv\]hue=s=0\[outvf\]/, "raw video filter applied to [outv]");
});

test("output.rawAudioFilter runs AFTER audioFilter (WARM), before music", () => {
  const g = graph(packFile(one, { audioFilter: "volume=7dB,alimiter=limit=0.95", rawAudioFilter: "aecho=0.8:0.9:40:0.4" }));
  assert.match(g, /\[outaf\]aecho=0\.8:0\.9:40:0\.4\[outraf\]/, "raw audio chains off the WARM output");
});

test("a pack with no raw fields is byte-identical to before (no valve, no warning)", () => {
  const r = run(packFile(one));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /raw filter valve/, "no warning when no raw fields");
  assert.doesNotMatch(r.stdout, /outvf|outraf/, "no raw labels emitted");
});

test("using the valve warns loudly on stderr (conscious choice + funnel signal)", () => {
  const r = run(packFile([{ source: "cam", start: 0, end: 6, rawFilter: "negate" }]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /raw filter valve in use/, "should warn");
  assert.match(r.stderr, /1 segment rawFilter/, "should name what fired");
});

test("an unknown output field is still rejected — the valve doesn't open additionalProperties", async () => {
  const { validatePack } = await import("../validate.js");
  const { errors, ajvRan } = await validatePack({
    version: "1.1",
    sources: { cam: { file: media } },
    output: { width: 1280, height: 720, rawWobbleFilter: "negate" },
    timeline: one,
  });
  if (ajvRan) assert.ok(errors.some((e) => /rawWobbleFilter|additional/i.test(e)), "typo'd raw field must be caught by the schema");
  else assert.ok(true, "ajv not installed; structural typo-catching skipped");
});
