#!/usr/bin/env node
/**
 * Edator edit-pack validator.
 *
 * The whole design rests on the pack being correct ("if the output is wrong, the
 * pack was wrong"), so we fail fast and clearly *before* spawning ffmpeg.
 *
 * Two layers:
 *   1. Semantic checks — dependency-free, ALWAYS run. These are the things a JSON
 *      schema can't express: dangling source references, captions outside their
 *      segment, image segments with no audio, multi-roll without a canvas size.
 *      Each error names the segment index + field.
 *   2. Structural checks — run only if `ajv` is installed. Validates the pack
 *      against references/edit-pack.schema.json, which catches typo'd fields
 *      (`captionz`), wrong types, bad enums and `additionalProperties` violations.
 *      Kept optional so the renderer still runs out-of-box with zero deps; run
 *      `npm install` in this directory to turn strict checks on.
 *
 * Usage:
 *   node validate.js <pack.json>
 *
 * Programmatic:
 *   import { validatePack } from "./validate.js";
 *   const { errors, ajvRan } = await validatePack(pack, packDir);
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "..", "references", "edit-pack.schema.json");

const IMAGE_EXEMPT = 1 / 1000; // treat sub-millisecond as a likely mistake

// ---- semantic checks (dependency-free, always on) ------------------------
function semanticErrors(pack) {
  const e = [];
  if (!pack || typeof pack !== "object") return ["Pack is not an object."];
  if (pack.version !== "1.0" && pack.version !== "1.1") e.push(`version: "${pack.version}" is not supported (expected "1.0" or "1.1").`);
  if (!pack.sources || typeof pack.sources !== "object") { e.push("sources: missing or not an object."); return e; }
  if (!Array.isArray(pack.timeline) || pack.timeline.length === 0) { e.push("timeline: must be a non-empty array."); return e; }

  const sourceKeys = new Set(Object.keys(pack.sources));
  const isImage = (k) => !!pack.sources[k]?.image;
  const has = (k) => sourceKeys.has(k);

  const out = pack.output || {};
  const hasCanvas = Number.isInteger(out.width) && Number.isInteger(out.height);

  // global audio bed
  if (pack.audio != null && !has(pack.audio)) e.push(`audio: bed references unknown source "${pack.audio}".`);

  // multi-roll needs a canvas
  const rolls = new Set(pack.timeline.flatMap((s) => [s.source, s.pip?.source].filter(Boolean)));
  if (rolls.size > 1 && !hasCanvas) e.push("output.width/height: required once the timeline switches rolls or uses pip (so frames share a canvas).");

  pack.timeline.forEach((seg, i) => {
    const at = `timeline[${i}]`;
    if (typeof seg.source !== "string") { e.push(`${at}.source: missing.`); return; }
    if (!has(seg.source)) e.push(`${at}.source: unknown source "${seg.source}".`);
    if (typeof seg.start !== "number" || typeof seg.end !== "number") { e.push(`${at}: start/end must be numbers.`); return; }
    if (seg.end <= seg.start) e.push(`${at}: end (${seg.end}) must be greater than start (${seg.start}).`);
    if (seg.start < 0) e.push(`${at}.start: must be >= 0.`);
    if (seg.end - seg.start < IMAGE_EXEMPT) e.push(`${at}: duration ${(seg.end - seg.start).toFixed(4)}s is suspiciously sub-frame.`);

    if (seg.pip) {
      if (typeof seg.pip.source !== "string" || !has(seg.pip.source)) e.push(`${at}.pip.source: unknown source "${seg.pip?.source}".`);
    }
    if (seg.audio != null && !has(seg.audio)) e.push(`${at}.audio: unknown source "${seg.audio}".`);

    // image segment needs sound from somewhere (the still has none)
    if (isImage(seg.source) && seg.audio == null && pack.audio == null) {
      e.push(`${at}: source "${seg.source}" is an image (no audio) — set this segment's "audio" or the global "audio" bed.`);
    }

    // captions must fall inside the segment's source-time window
    if (Array.isArray(seg.captions)) {
      seg.captions.forEach((c, j) => {
        const cat = `${at}.captions[${j}]`;
        if (typeof c.start !== "number" || typeof c.end !== "number") { e.push(`${cat}: start/end must be numbers.`); return; }
        if (c.end <= c.start) e.push(`${cat}: end must be greater than start.`);
        if (c.start < seg.start - 1e-6 || c.end > seg.end + 1e-6) {
          e.push(`${cat}: [${c.start},${c.end}] falls outside the segment window [${seg.start},${seg.end}] — captions are timed in source-time.`);
        }
      });
    }
  });

  return e;
}

// ---- structural checks (ajv, optional) -----------------------------------
async function structuralErrors(pack) {
  let Ajv;
  try { ({ default: Ajv } = await import("ajv")); }
  catch { return { ran: false, errors: [] }; } // ajv not installed — semantic checks still ran
  try {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (validate(pack)) return { ran: true, errors: [] };
    const errors = (validate.errors || []).map((er) => {
      const where = er.instancePath || "(root)";
      if (er.keyword === "additionalProperties") return `${where}: unknown field "${er.params.additionalProperty}" (typo? not in the schema).`;
      if (er.keyword === "enum") return `${where}: ${er.message} (${er.params.allowedValues.join(", ")}).`;
      return `${where}: ${er.message}.`;
    });
    return { ran: true, errors };
  } catch (err) {
    return { ran: false, errors: [`(schema validation skipped: ${err.message})`] };
  }
}

/** Validate a parsed pack. Returns { errors: string[], ajvRan: boolean }. */
export async function validatePack(pack) {
  const errors = semanticErrors(pack);
  const { ran, errors: structural } = await structuralErrors(pack);
  // Structural typo/type errors are valuable; list them after the semantic ones.
  return { errors: [...errors, ...structural], ajvRan: ran };
}

// ---- CLI -----------------------------------------------------------------
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const file = process.argv[2];
  if (!file) { console.error("Usage: node validate.js <pack.json>"); process.exit(2); }
  const path = resolve(file);
  if (!existsSync(path)) { console.error(`✗ Pack not found: ${path}`); process.exit(2); }
  let pack;
  try { pack = JSON.parse(readFileSync(path, "utf8")); }
  catch (err) { console.error(`✗ Not valid JSON: ${err.message}`); process.exit(1); }

  const { errors, ajvRan } = await validatePack(pack);
  if (!ajvRan) console.error("ℹ strict schema checks skipped — run `npm install` in scripts/ to enable ajv (typo/type catching).");
  if (errors.length) {
    console.error(`✗ ${path} is invalid:`);
    for (const e of errors) console.error(`  • ${e}`);
    process.exit(1);
  }
  console.log(`✓ ${path} is a valid edit pack${ajvRan ? " (semantic + schema)" : " (semantic only)"}.`);
}
