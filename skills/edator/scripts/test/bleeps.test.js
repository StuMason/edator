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
  const dir = mkdtempSync(join(tmpdir(), "edator-bleep-"));
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

test("a bleep mutes the word and drops a 1kHz tone in its place", () => {
  const g = graph(packFile([
    { source: "cam", start: 4, end: 10, bleeps: [{ start: 6, end: 7 }] },
  ]));
  // speech is muted only across the window, not the whole segment
  assert.match(g, /volume=0:enable=between\(t\\,2\\,3\)/, "mutes the word window (source 6-7 → output 2-3)");
  // a 1kHz sine, delayed onto the word, mixed back over the muted speech
  assert.match(g, /sine=frequency=1000/, "generates a 1kHz tone");
  assert.match(g, /adelay=2000\|2000/, "delays the tone to land on the word");
  assert.match(g, /,volume=1\[bz/, "tone sits at speech level, not a klaxon");
  assert.match(g, /amix=inputs=2:duration=first:normalize=0/, "mixes tone over the muted speech without re-levelling");
});

test("no bleeps → one clean audio line, no mute/tone/mix", () => {
  const g = graph(packFile([{ source: "cam", start: 0, end: 6 }]));
  assert.doesNotMatch(g, /sine=frequency=1000/, "no tone generated");
  assert.doesNotMatch(g, /volume=0:enable/, "speech is never muted");
  assert.doesNotMatch(g, /\bamix=/, "no bleep mix stage");
});

test("bleep windows are projected to the OUTPUT clock under speed (÷ speed)", () => {
  // segment [4,10] at 2× → output 0-3s; a source-time word at 6-7 lands at output 1.0-1.5
  const g = graph(packFile([
    { source: "cam", start: 4, end: 10, speed: 2, bleeps: [{ start: 6, end: 7 }] },
  ]));
  assert.match(g, /volume=0:enable=between\(t\\,1\\,1\.5\)/, "window divided by speed");
  assert.match(g, /adelay=1000\|1000/, "tone offset divided by speed");
});

test("multiple bleeps in one segment → one tone per window, all mixed in", () => {
  const g = graph(packFile([
    { source: "cam", start: 0, end: 12, bleeps: [{ start: 2, end: 3 }, { start: 8, end: 9 }] },
  ]));
  const tones = g.match(/sine=frequency=1000/g) || [];
  assert.equal(tones.length, 2, "a tone per window");
  assert.match(g, /between\(t\\,2\\,3\)\+between\(t\\,8\\,9\)/, "both windows muted in one enable expr");
  assert.match(g, /amix=inputs=3:duration=first/, "muted speech + two tones = 3 inputs");
});
