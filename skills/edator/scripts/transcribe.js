#!/usr/bin/env node
/**
 * Edator — transcription step.
 *
 * Extracts the audio from a recording, sends it to AssemblyAI (Universal-3 Pro,
 * with disfluencies so "um"/"uh"/false-starts are kept and timestamped), and
 * writes the full transcript JSON — including the word-level `words` array — so
 * the edit-pack step has exact in/out points to cut on.
 *
 * Usage:
 *   node transcribe.js <video-or-audio> [--out <transcript.json>]
 *
 * Needs ASSEMBLYAI_API_KEY (env, or read from repo-root .env).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join, basename, extname } from "node:path";

const API = "https://api.assemblyai.com/v2";

function die(m) { console.error(`✗ ${m}`); process.exit(1); }

function getKey() {
  if (process.env.ASSEMBLYAI_API_KEY) return process.env.ASSEMBLYAI_API_KEY.trim();
  // fall back to a .env in the working directory
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(/^\s*ASSEMBLYAI_API_KEY\s*=\s*(.+)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, "").trim();
  }
  die("ASSEMBLYAI_API_KEY not found (set the env var, or put it in a .env in the current directory).");
}

const args = process.argv.slice(2);
if (!args[0]) die("Usage: node transcribe.js <video-or-audio> [--out <transcript.json>]");
const input = resolve(args[0]);
if (!existsSync(input)) die(`Input not found: ${input}`);
const outIdx = args.indexOf("--out");
const outPath = outIdx !== -1 ? resolve(args[outIdx + 1])
  : join(dirname(input), basename(input, extname(input)) + ".transcript.json");

const key = getKey();

// 1. Extract mono 16kHz mp3 — small upload, plenty for ASR.
const work = mkdtempSync(join(tmpdir(), "edator-"));
const audio = join(work, "audio.mp3");
console.log("Extracting audio…");
const ff = spawnSync("ffmpeg", ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-q:a", "5", audio], { stdio: ["ignore", "ignore", "inherit"] });
if (ff.status !== 0) die("ffmpeg audio extraction failed.");

// 2. Upload.
console.log("Uploading to AssemblyAI…");
const bytes = readFileSync(audio);
const up = await fetch(`${API}/upload`, { method: "POST", headers: { authorization: key }, body: bytes });
if (!up.ok) die(`Upload failed: ${up.status} ${await up.text()}`);
const { upload_url } = await up.json();

// 3. Request transcript — latest model, keep disfluencies.
console.log("Transcribing (Universal-3 Pro)…");
const req = await fetch(`${API}/transcript`, {
  method: "POST",
  headers: { authorization: key, "content-type": "application/json" },
  body: JSON.stringify({
    audio_url: upload_url,
    speech_models: ["universal-3-pro"],
    disfluencies: true,
    punctuate: true,
    format_text: true,
  }),
});
if (!req.ok) die(`Transcript request failed: ${req.status} ${await req.text()}`);
let job = await req.json();

// 4. Poll.
while (job.status !== "completed" && job.status !== "error") {
  await new Promise((r) => setTimeout(r, 3000));
  const poll = await fetch(`${API}/transcript/${job.id}`, { headers: { authorization: key } });
  job = await poll.json();
  process.stdout.write(`  status: ${job.status}\r`);
}
console.log("");
if (job.status === "error") die(`AssemblyAI error: ${job.error}`);

writeFileSync(outPath, JSON.stringify(job, null, 2));
const words = job.words?.length ?? 0;
const dur = job.audio_duration ?? "?";
console.log(`✓ Transcript saved: ${outPath}`);
console.log(`  ${words} words · ${dur}s audio · model: ${job.speech_model || "universal-3-pro"}`);
