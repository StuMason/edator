import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const report = resolve(__dirname, "..", "report.js");
const example = resolve(__dirname, "..", "..", "..", "..", "examples", "edit-pack.example.json");

const run = (args) => spawnSync("node", [report, ...args], { encoding: "utf8" });

test("report --json emits the scorecard metrics for the example pack", () => {
  const r = run([example, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.ok(j.runtime > 0, "runtime should be positive");
  assert.equal(j.segments, 5, "example has 5 segments");
  assert.ok("talkingHeadPct" in j);
  assert.ok(j.moves.pip >= 1, "example uses a pip");
  assert.ok(j.moves.zoom >= 1, "example uses a zoom");
  assert.ok(j.moves.image >= 1, "example uses an image B-roll");
  assert.ok(j.moves.speed >= 1, "example uses a speed ramp");
  assert.deepEqual(j.validationErrors, [], "example should validate clean");
});

test("report text mode prints all four scorecard dimensions", () => {
  const r = run([example]);
  assert.equal(r.status, 0, r.stderr);
  for (const dim of ["TIGHTNESS", "VARIETY", "CORRECTNESS", "CEILING"]) {
    assert.ok(r.stdout.includes(dim), `missing dimension: ${dim}`);
  }
});

test("roll-balance is reported and a barely-shown roll is flagged", () => {
  // two-roll pack that keeps the screen hidden (face 90%) — the v1 fault
  const pack = {
    version: "1.1",
    sources: { face: { file: "f.mp4" }, screen: { file: "s.mp4" } },
    audio: "screen",
    output: { width: 1280, height: 720 },
    timeline: [{ source: "face", start: 0, end: 18 }, { source: "screen", start: 18, end: 20 }],
  };
  const tmp = resolve(__dirname, "_tmp_rolls.json");
  spawnSync("node", ["-e", `require('fs').writeFileSync(${JSON.stringify(tmp)}, ${JSON.stringify(JSON.stringify(pack))})`]);
  const j = JSON.parse(run([tmp, "--json"]).stdout);
  const text = run([tmp]).stdout;
  spawnSync("rm", ["-f", tmp]);
  assert.ok(Array.isArray(j.rollBalance) && j.rollBalance[0].source === "face", "face should be the dominant roll");
  assert.ok(j.rollBalance[0].pct > 0.85, "face should be >85%");
  assert.ok(text.includes("ROLLS"), "scorecard prints a ROLLS line");
  assert.ok(text.includes("dominates"), "a dominated roll should be flagged");
});

test("report flags an over-processed (non-warm) audio filter", () => {
  // build a pack with loudnorm and check the JSON flags it
  const pack = {
    version: "1.1",
    sources: { a: { file: "x.mp4" } },
    output: { width: 1280, height: 720, audioFilter: "loudnorm=I=-16" },
    timeline: [{ source: "a", start: 0, end: 5 }],
  };
  const tmp = resolve(__dirname, "_tmp_report.json");
  spawnSync("node", ["-e", `require('fs').writeFileSync(${JSON.stringify(tmp)}, ${JSON.stringify(JSON.stringify(pack))})`]);
  const r = run([tmp, "--json"]);
  spawnSync("rm", ["-f", tmp]);
  const j = JSON.parse(r.stdout);
  assert.equal(j.audioBad, true, "loudnorm should be flagged as not-warm");
  assert.equal(j.audioWarm, false);
});
