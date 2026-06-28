import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const render = resolve(__dirname, "..", "render.js");

// A schema-valid pack whose "media" is just an existing file (render.js itself) —
// --dry-run builds the filter graph without probing or running ffmpeg.
function packFile(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "edator-fonttest-"));
  const p = join(dir, "pack.json");
  const seg = { source: "m", start: 0, end: 5 };
  if (opts.captioned) seg.captions = [{ text: "hi", style: "plain", start: 1, end: 3 }];
  writeFileSync(p, JSON.stringify({
    version: "1.1",
    sources: { m: { file: render } },
    output: { filename: "x.mp4", width: 1280, height: 720, fps: 30 },
    timeline: [seg],
  }));
  return p;
}

const run = (pack, env = {}) => spawnSync("node", [render, pack, "--dry-run"], { encoding: "utf8", env: { ...process.env, ...env } });

test("a captioned pack resolves some font on the host", () => {
  const r = run(packFile({ captioned: true }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fontfile=/, "the graph should reference a resolved font");
});

test("EDATOR_FONT override is honoured", () => {
  const font = join(mkdtempSync(join(tmpdir(), "edator-f-")), "fake.ttf");
  writeFileSync(font, "x");
  const r = run(packFile({ captioned: true }), { EDATOR_FONT: font });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(font), "the override font path should appear in the graph");
});

test("a missing font override fails clearly when a caption needs it", () => {
  const r = run(packFile({ captioned: true }), { EDATOR_FONT: "/no/such/font.ttf" });
  assert.notEqual(r.status, 0, "should exit non-zero");
  assert.match(r.stderr, /doesn't exist|No bold sans/, "should name the font problem");
});

test("a pack with no captions renders even when no font is available", () => {
  // bad override — but the pack draws nothing, so a font is never needed
  const r = run(packFile({ captioned: false }), { EDATOR_FONT: "/no/x.ttf" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /concat=n=/, "should still build the graph");
});
