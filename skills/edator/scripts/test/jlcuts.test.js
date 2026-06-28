import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// J-cuts & L-cuts: audio bleeds across a join (POLISH-BACKLOG #1). The feature is
// additive — a pack with no audioLead/audioTrail renders the unchanged concat
// spine (covered by the golden snapshots). Here we assert the bleed structure
// appears, lands at the right output time, and never fires on a boundary segment.

const __dirname = dirname(fileURLToPath(import.meta.url));
const render = resolve(__dirname, "..", "render.js");
const fixturesDir = resolve(__dirname, "fixtures");
const env = { ...process.env, EDATOR_FONT: join(fixturesDir, "font.ttf") };

function graphFor(pack) {
  const r = spawnSync("node", [render, "/dev/stdin", "--dry-run"], { encoding: "utf8", env, input: JSON.stringify(pack) });
  assert.equal(r.status, 0, `dry-run failed:\n${r.stderr}`);
  const marker = "--- filter_complex ---\n";
  const i = r.stdout.indexOf(marker);
  assert.ok(i !== -1, "no filter_complex");
  return r.stdout.slice(i + marker.length).trim();
}

const base = {
  version: "1.1",
  sources: { cam: { file: join(fixturesDir, "media/cam.mp4"), fps: 30 }, screen: { file: join(fixturesDir, "media/screen.mp4"), fps: 30 } },
  audio: "screen",
  output: { width: 1280, height: 720, fps: 30, audioFilter: "volume=7dB,alimiter=limit=0.95" },
};

test("no audioLead/audioTrail leaves the audio spine untouched", () => {
  const g = graphFor({ ...base, timeline: [
    { source: "cam", start: 0, end: 6 },
    { source: "screen", start: 6, end: 15 },
  ]});
  assert.ok(!g.includes("[jlmute]"), "spine should not be muted without J/L cuts");
  assert.ok(!g.includes("[jlmix]"), "no bleed mix without J/L cuts");
});

test("an L-cut bleeds the segment's tail audio under the next picture", () => {
  // seg0 cam [0,6] trails 0.5s → pull source [6, 6.5], placed at output t=6
  const g = graphFor({ ...base, timeline: [
    { source: "cam", start: 0, end: 6, audioTrail: 0.5 },
    { source: "screen", start: 6, end: 15 },
  ]});
  assert.ok(g.includes("[jlmute]"), "spine is muted under the bleed");
  assert.ok(g.includes("[jlmix]"), "a bleed mix is produced");
  // audio bed is 'screen' (idx 1): the trail pulls from the heard source.
  assert.ok(/\[1:a\]atrim=start=6:end=6\.5/.test(g), `expected trail atrim 6→6.5\n${g}`);
  assert.ok(/adelay=6000\|6000/.test(g), `expected delay to output t=6s\n${g}`);
  assert.ok(/volume=0:enable='between\(t\\,6\\,6\.5\)'/.test(g), `expected spine mute 6→6.5\n${g}`);
});

test("a J-cut bleeds the next segment's head audio under the previous picture", () => {
  // seg1 screen [6,15] leads 0.4s → pull source [5.6, 6], placed at output t=5.6
  const g = graphFor({ ...base, timeline: [
    { source: "cam", start: 0, end: 6 },
    { source: "screen", start: 6, end: 15, audioLead: 0.4 },
  ]});
  assert.ok(/\[1:a\]atrim=start=5\.6:end=6/.test(g), `expected lead atrim 5.6→6\n${g}`);
  assert.ok(/adelay=5600\|5600/.test(g), `expected delay to output t=5.6s\n${g}`);
});

test("audioLead on the first segment and audioTrail on the last are ignored", () => {
  const g = graphFor({ ...base, timeline: [
    { source: "cam", start: 0, end: 6, audioLead: 0.5 },
    { source: "screen", start: 6, end: 15, audioTrail: 0.5 },
  ]});
  assert.ok(!g.includes("[jlmix]"), `boundary lead/trail must not fire\n${g}`);
});
