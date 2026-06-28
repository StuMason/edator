#!/usr/bin/env node
/**
 * Edator loudness — measure integrated LUFS and trim to a platform target with a
 * SINGLE static gain (POLISH-BACKLOG #3). NOT loudnorm.
 *
 * The locked WARM rule is right that loudnorm slamming a Rode is pumpy and
 * robotic — but "warm beats loud" still needs a reference, or an episode at
 * -19 LUFS plays quieter than everything around it and reads as amateur. The pro
 * move that doesn't touch dynamics: measure integrated LUFS once, then apply ONE
 * `volume` gain to land near -14 LUFS (YouTube's normalization target). No
 * compression, mic character intact. We measure WITH loudnorm but never apply it.
 *
 * The gain is peak-guarded: we never push true-peak above the ceiling (-1 dBTP by
 * default), so landing a touch under target beats clipping.
 *
 * Importable: `measure(file)` returns the raw integrated/true-peak/LRA numbers.
 *
 * Usage:
 *   node loudness.js <in.mp4> [--json]                 # measure only
 *   node loudness.js <in.mp4> -o <out.mp4> [--json]    # measure + apply the trim
 *     [--target -14] [--tp -1]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

// ── measure (loudnorm in print-only mode emits a JSON block on stderr) ───────
export function measure(file) {
  const r = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-i", file,
    "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"], { encoding: "utf8" });
  const m = (r.stderr || "").match(/\{[\s\S]*?\}/g);
  if (!m) die(`could not parse loudness from ffmpeg output:\n${(r.stderr || "").slice(-400)}`);
  const j = JSON.parse(m[m.length - 1]);
  return { i: +j.input_i, tp: +j.input_tp, lra: +j.input_lra, thresh: +j.input_thresh };
}

// Plan the peak-guarded static gain toward a target. Pure arithmetic on a measure().
export function planGain(meas, target = -14, tpCeil = -1) {
  const gainToTarget = target - meas.i;
  const gainToPeak = tpCeil - meas.tp;
  const gain = +Math.min(gainToTarget, gainToPeak).toFixed(2);
  const peakLimited = gainToPeak < gainToTarget - 0.01;
  const out = {
    input: { lufs: meas.i, truePeak: meas.tp, lra: meas.lra },
    target, gainDb: gain, peakLimited,
    predicted: { lufs: +(meas.i + gain).toFixed(2), truePeak: +(meas.tp + gain).toFixed(2) },
  };
  if (peakLimited) {
    out.note = `static trim can't reach ${target} LUFS without clipping (true-peak ${meas.tp} dBTP). ` +
      `To truly hit target, raise the render's WARM volume by ~${gainToTarget >= 0 ? "+" : ""}${gainToTarget.toFixed(1)} dB (before alimiter), don't post-trim.`;
    out.renderGainSuggestionDb = +gainToTarget.toFixed(1);
  }
  return out;
}

// Delivery policy: produce a peak-safe master with a SINGLE static gain (no
// compression), and never make a quiet master quieter. Decides between a clean
// lift to target, a peak-limited partial lift, a minimal de-clip, or a no-op.
export function planDelivery(meas, target = -14, tpCeil = -1) {
  const liftToTarget = +(target - meas.i).toFixed(2);
  const peakAfterLift = +(meas.tp + liftToTarget).toFixed(2);
  const tpSafe = -1.0;   // pre-AAC true-peak target for a de-clip (leaves headroom for AAC re-expansion)
  let gain = 0, action = "within tolerance — clean remux, no gain change";
  if (liftToTarget > 0.3 && peakAfterLift <= tpCeil) {
    // Clean lift: there's headroom to reach target without clipping.
    gain = liftToTarget;
    action = `lifted +${gain} dB to ${target} LUFS`;
  } else if (meas.tp > tpSafe) {
    // Master is HOT (clipping or near it) and can't be cleanly lifted — de-clip to
    // a peak-safe level with ONE static reduction (no compression). Always do this
    // when the peak is hot, even if the master is also under target: ship it
    // clip-free and flag that the real loudness fix is render-side.
    gain = +(tpSafe - meas.tp).toFixed(2);
    action = liftToTarget > 0.3
      ? `de-clipped ${gain} dB — can't lift to ${target} without clipping; raise the render's WARM volume ~+${liftToTarget} dB to truly hit target`
      : `de-clipped ${gain} dB (true-peak was ${meas.tp} dBTP)`;
  } else if (liftToTarget > 0.3) {
    // Quiet but already peak-safe: a lift would clip, so leave it (a lossy de-clip
    // that makes a quiet master quieter is net-negative). Fix is render-side.
    action = `left as-is — ${liftToTarget} dB under ${target} but peak-safe; raise the render's WARM volume to lift`;
  }
  return {
    input: { lufs: meas.i, truePeak: meas.tp, lra: meas.lra },
    target, gainDb: gain, action,
    predicted: { lufs: +(meas.i + gain).toFixed(2), truePeak: +(meas.tp + gain).toFixed(2) },
  };
}

// ── CLI (only when run directly, never on import) ────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  if (!argv[0] || argv.includes("-h") || argv.includes("--help")) {
    console.log("Usage: node loudness.js <in.mp4> [-o <out.mp4>] [--target -14] [--tp -1] [--json]");
    process.exit(argv[0] ? 0 : 1);
  }
  const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const inPath = resolve(argv[0]);
  if (!existsSync(inPath)) die(`not found: ${inPath}`);
  const outPath = flag("-o") ? resolve(flag("-o")) : null;
  const target = +(flag("--target", "-14"));
  const tpCeil = +(flag("--tp", "-1"));
  const wantJson = argv.includes("--json");
  const deliver = argv.includes("--deliver");

  const meas = measure(inPath);
  const result = deliver ? planDelivery(meas, target, tpCeil) : planGain(meas, target, tpCeil);

  if (outPath) {
    const af = result.gainDb ? ["-af", `volume=${result.gainDb}dB`, "-c:a", "aac", "-b:a", "192k"] : ["-c:a", "copy"];
    const r = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-v", "error", "-i", inPath,
      "-c:v", "copy", ...af, "-movflags", "+faststart", "-y", outPath], { stdio: "inherit" });
    if (r.status !== 0) die(`ffmpeg trim failed (exit ${r.status})`);
    result.output = outPath;
  }

  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const g = result.gainDb;
    console.log(`LUFS ${result.input.lufs} → ${result.predicted.lufs}  ·  true-peak ${result.input.truePeak} → ${result.predicted.truePeak} dBTP  ·  gain ${g >= 0 ? "+" : ""}${g} dB${result.peakLimited ? "  (peak-limited)" : ""}`);
    if (result.action) console.log(`  ${result.action}`);
    if (result.note) console.log(`  ⚠ ${result.note}`);
    if (outPath) console.log(`✓ → ${outPath}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
