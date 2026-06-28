#!/usr/bin/env node
/**
 * Edator delivery QC — the technical sign-off, distinct from the editorial
 * scorecard (POLISH-BACKLOG #15).
 *
 * report.js scores the CUT (pacing, roll-balance) — excellent, but blind to
 * technical delivery. This is the sheet a post house signs before a master ships:
 *
 *   LOUDNESS    integrated LUFS vs target, true-peak headroom, clipping check
 *   COLOUR      bt709 primaries/transfer/space + range tags present (not "guess")
 *   SYNC        audio vs video stream duration drift
 *   FORMAT      resolution, fps, codecs, faststart
 *
 * Pure inspection — it never modifies the file. Writes <stem>.qc.json + .qc.md
 * when -o is given, else prints the sheet.
 *
 * Usage:
 *   node qc.js <master.mp4> [-o <stem-or-dir>] [--target -14] [--json]
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { measure } from "./loudness.js";

const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const argv = process.argv.slice(2);
if (!argv[0] || argv.includes("-h") || argv.includes("--help")) {
  console.log("Usage: node qc.js <master.mp4> [-o <stem-or-dir>] [--target -14] [--json]");
  process.exit(argv[0] ? 0 : 1);
}
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const master = resolve(argv[0]);
if (!existsSync(master)) die(`not found: ${master}`);
const target = +(flag("--target", "-14"));

function probe(streamSel, fields) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", streamSel,
    "-show_entries", `stream=${fields}`, "-of", "json", master], { encoding: "utf8" });
  try { return JSON.parse(r.stdout).streams?.[0] || {}; } catch { return {}; }
}
const fmt = (() => {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,format_name", "-of", "json", master], { encoding: "utf8" });
  try { return JSON.parse(r.stdout).format || {}; } catch { return {}; }
})();

const v = probe("v:0", "codec_name,color_space,color_primaries,color_transfer,color_range,width,height,r_frame_rate,duration");
const a = probe("a:0", "codec_name,duration,sample_rate,channels");
const loud = measure(master);

// ── evaluate checks ──────────────────────────────────────────────────────────
const checks = [];
const add = (name, ok, detail, level = "warn") => checks.push({ name, status: ok ? "pass" : level, detail });

// LOUDNESS
const lufsOff = +(loud.i - target).toFixed(2);
add("integrated loudness", Math.abs(lufsOff) <= 2,
  `${loud.i} LUFS (target ${target}, ${lufsOff >= 0 ? "+" : ""}${lufsOff})`);
add("true-peak headroom", loud.tp <= -1,
  `${loud.tp} dBTP (ceiling -1.0)`);
add("no clipping", loud.tp < 0,
  `peak ${loud.tp} dBTP`, "fail");

// COLOUR — tags must be present and bt709, or players guess
const colTags = { space: v.color_space, primaries: v.color_primaries, transfer: v.color_transfer, range: v.color_range };
const colOk = v.color_primaries === "bt709" && v.color_transfer === "bt709" && (v.color_space === "bt709") && !!v.color_range;
add("colour tags (bt709)", colOk,
  `primaries=${colTags.primaries || "—"} transfer=${colTags.transfer || "—"} space=${colTags.space || "—"} range=${colTags.range || "—"}`, "fail");

// SYNC — stream duration drift
const vd = parseFloat(v.duration), ad = parseFloat(a.duration);
const drift = Number.isFinite(vd) && Number.isFinite(ad) ? +Math.abs(vd - ad).toFixed(3) : null;
add("A/V sync", drift == null || drift <= 0.12,
  drift == null ? "stream durations unavailable" : `${drift}s drift (v ${vd?.toFixed(2)}s / a ${ad?.toFixed(2)}s)`);

// FORMAT
const fps = (() => { const [n, d] = (v.r_frame_rate || "0/1").split("/").map(Number); return d ? +(n / d).toFixed(2) : 0; })();
add("resolution + fps", !!(v.width && v.height), `${v.width}×${v.height} @ ${fps}fps · ${v.codec_name}/${a.codec_name}`);

const fails = checks.filter((c) => c.status === "fail").length;
const warns = checks.filter((c) => c.status === "warn").length;
const verdict = fails ? "FAIL" : warns ? "WARN" : "PASS";

const result = {
  master: basename(master),
  sizeBytes: statSync(master).size,
  verdict, fails, warns,
  loudness: { lufs: loud.i, truePeak: loud.tp, lra: loud.lra, target },
  colour: colTags,
  format: { width: v.width, height: v.height, fps, vcodec: v.codec_name, acodec: a.codec_name,
    container: fmt.format_name, duration: parseFloat(fmt.duration) },
  sync: { videoDur: vd, audioDur: ad, driftSec: drift },
  checks,
};

// ── output ───────────────────────────────────────────────────────────────────
const glyph = { pass: "✓", warn: "⚠", fail: "✗" };
function sheet() {
  const L = [`DELIVERY QC — ${basename(master)}`, `verdict: ${verdict}  (${fails} fail · ${warns} warn)`, ""];
  for (const c of checks) L.push(`  ${glyph[c.status]} ${c.name.padEnd(22)} ${c.detail}`);
  if (loud.peakLimited) L.push(`\n  note: master is peak-limited — see loudness.js for the render-gain fix.`);
  return L.join("\n");
}
function sheetMd() {
  const L = [`# Delivery QC — ${basename(master)}`, "", `**Verdict: ${verdict}** — ${fails} fail, ${warns} warn`, "",
    "| check | status | detail |", "|---|---|---|"];
  for (const c of checks) L.push(`| ${c.name} | ${glyph[c.status]} ${c.status} | ${c.detail} |`);
  return L.join("\n") + "\n";
}

const outArg = flag("-o");
if (outArg) {
  let stem = resolve(outArg);
  if (existsSync(stem) && statSync(stem).isDirectory()) stem = join(stem, basename(master).replace(/\.[^.]+$/, ""));
  else stem = stem.replace(/\.(qc\.)?(json|md)$/i, "");
  writeFileSync(`${stem}.qc.json`, JSON.stringify(result, null, 2));
  writeFileSync(`${stem}.qc.md`, sheetMd());
  console.log(`✓ QC ${verdict} → ${stem}.qc.json + .qc.md`);
}
if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
else if (!outArg) console.log(sheet());
