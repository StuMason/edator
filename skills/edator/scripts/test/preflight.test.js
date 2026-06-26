import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSilences, classifyDeadAir, parseFreezes, parseBlacks,
  parseVolume, fpsVerdict, segmentsHitting, realFreezes,
} from "../preflight.js";

// Real ffmpeg stderr fragments — the parsers must read exactly these.

test("parseSilences reads start/end pairs and computes duration", () => {
  const s = `[silencedetect @ 0x1] silence_start: 9.06
[silencedetect @ 0x1] silence_end: 9.68 | silence_duration: 0.62`;
  assert.deepEqual(parseSilences(s, 200), [{ start: 9.06, end: 9.68, dur: 0.62 }]);
});

test("parseSilences closes a trailing silence with no _end at the duration", () => {
  const s = `[silencedetect @ 0x1] silence_start: 195.5`;
  assert.deepEqual(parseSilences(s, 196.5), [{ start: 195.5, end: 196.5, dur: 1 }]);
});

test("classifyDeadAir types leading / trailing / gap / pause / breath", () => {
  const sil = [
    { start: 0, end: 3.5, dur: 3.5 },        // leading
    { start: 40, end: 42.1, dur: 2.1 },      // gap (>=1.2)
    { start: 80, end: 80.8, dur: 0.8 },      // pause (>=0.6)
    { start: 100, end: 100.3, dur: 0.3 },    // breath
    { start: 195.7, end: 196.5, dur: 0.8 },  // trailing (ends at duration)
  ];
  const t = classifyDeadAir(sil, 196.5).map((x) => x.type);
  assert.deepEqual(t, ["leading", "gap", "pause", "breath", "trailing"]);
});

test("parseFreezes captures a freeze that runs to EOF", () => {
  const s = `[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 156.6`;
  assert.deepEqual(parseFreezes(s, 196.5), [{ start: 156.6, end: 196.5, dur: 39.9 }]);
});

test("parseBlacks reads same-line start/end", () => {
  const s = `[blackdetect @ 0x1] black_start:12 black_end:13.5 black_duration:1.5`;
  assert.deepEqual(parseBlacks(s, 200), [{ start: 12, end: 13.5, dur: 1.5 }]);
});

test("parseVolume reads mean and max", () => {
  const s = `[Parsed_volumedetect_0 @ 0x1] mean_volume: -32.1 dB
[Parsed_volumedetect_0 @ 0x1] max_volume: -3.9 dB`;
  assert.deepEqual(parseVolume(s), { mean: -32.1, max: -3.9 });
});

test("fpsVerdict flags variable frame rate", () => {
  assert.equal(fpsVerdict("30/1", "30/1").vfr, false);
  assert.equal(fpsVerdict("30/1", "29001/1000").vfr, true);   // avg drifts → VFR
});

test("realFreezes: silent roll = camera death, voiced roll = expected static, short = ident", () => {
  const freezes = [{ start: 150, end: 196, dur: 46 }];
  assert.equal(realFreezes({ silent: true, duration: 196, freezes }).length, 1, "silent long roll → death");
  assert.equal(realFreezes({ silent: false, duration: 196, freezes }).length, 0, "voiced roll → slide, ignored");
  assert.equal(realFreezes({ silent: true, duration: 2.4, freezes }).length, 0, "short silent → ident, ignored");
});

test("segmentsHitting maps a freeze window onto the segments that land in it", () => {
  const pack = {
    audio: "screen",
    timeline: [
      { source: "face", start: 150.2, end: 166.9 },   // crosses the freeze
      { source: "screen", start: 0, end: 30 },         // a different roll
      { source: "face", start: 189.4, end: 195.8 },    // inside the freeze
    ],
  };
  const freeze = [{ start: 156.6, end: 196.5 }];
  const hits = segmentsHitting(pack, "face", freeze, "video").map((h) => h.seg);
  assert.deepEqual(hits, [0, 2], "both face segments overlapping the freeze are flagged");
});

test("segmentsHitting in audio role follows the heard bed, not the visible roll", () => {
  const pack = {
    audio: "screen",
    timeline: [{ source: "face", start: 80, end: 90 }],   // visible face, heard screen
  };
  const gap = [{ start: 82, end: 87 }];   // a dead-air gap in the screen audio
  assert.equal(segmentsHitting(pack, "screen", gap, "audio").length, 1, "audio gap projects via the bed");
  assert.equal(segmentsHitting(pack, "face", gap, "audio").length, 0, "not via the visible roll");
});
