import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePack } from "../validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// A minimal valid two-roll pack used as the base for mutation in each test.
const base = () => ({
  version: "1.1",
  sources: {
    cam: { file: "recordings/camera.mp4" },
    screen: { file: "recordings/screen.mp4" },
    card: { file: "assets/card.png", image: true },
  },
  audio: "screen",
  output: { filename: "demo.mp4", width: 1280, height: 720, fps: 30 },
  timeline: [
    { source: "cam", start: 1, end: 5 },
    { source: "card", start: 5, end: 9, pip: { source: "cam", corner: "br" },
      captions: [{ text: "hi", style: "label", start: 6, end: 8 }] },
  ],
});

const hasError = (errors, needle) => errors.some((e) => e.includes(needle));

test("a valid pack passes", async () => {
  const { errors } = await validatePack(base());
  assert.deepEqual(errors, [], `expected no errors, got: ${errors.join(" | ")}`);
});

test("the shipped example pack passes", async () => {
  const pack = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "..", "..", "examples", "edit-pack.example.json"), "utf8"));
  const { errors } = await validatePack(pack);
  assert.deepEqual(errors, [], `example invalid: ${errors.join(" | ")}`);
});

test("dangling source reference is caught and located", async () => {
  const p = base();
  p.timeline[0].source = "nope";
  const { errors } = await validatePack(p);
  assert.ok(hasError(errors, "timeline[0].source"));
  assert.ok(hasError(errors, "nope"));
});

test("dangling pip source is caught", async () => {
  const p = base();
  p.timeline[1].pip.source = "ghost";
  const { errors } = await validatePack(p);
  assert.ok(hasError(errors, "pip.source"));
});

test("unknown global audio bed is caught", async () => {
  const p = base();
  p.audio = "mic";
  const { errors } = await validatePack(p);
  assert.ok(hasError(errors, "audio"));
});

test("caption outside its segment window is caught", async () => {
  const p = base();
  p.timeline[1].captions[0].end = 99; // segment ends at 9
  const { errors } = await validatePack(p);
  assert.ok(hasError(errors, "captions[0]"));
  assert.ok(hasError(errors, "outside"));
});

test("image segment with no audio source is caught", async () => {
  const p = base();
  delete p.audio; // remove the bed
  // timeline[1] uses the image 'card' with no per-segment audio now
  const { errors } = await validatePack(p);
  assert.ok(hasError(errors, "timeline[1]"));
  assert.ok(hasError(errors, "image"));
});

test("end must exceed start", async () => {
  const p = base();
  p.timeline[0].end = 1; // == start
  const { errors } = await validatePack(p);
  assert.ok(hasError(errors, "greater than start"));
});

test("multi-roll without a canvas size is caught", async () => {
  const p = base();
  delete p.output.width;
  delete p.output.height;
  const { errors } = await validatePack(p);
  assert.ok(hasError(errors, "output.width/height"));
});

test("typo'd field is caught when ajv is available", async () => {
  const p = base();
  p.timeline[0].captionz = []; // typo of "captions"
  const { errors, ajvRan } = await validatePack(p);
  if (ajvRan) {
    assert.ok(hasError(errors, "captionz"), `expected typo to be flagged, got: ${errors.join(" | ")}`);
  } else {
    // ajv not installed — semantic layer can't see this; document the skip.
    assert.ok(true, "ajv not installed; structural typo-catching skipped");
  }
});
