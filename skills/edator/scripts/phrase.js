#!/usr/bin/env node
/**
 * phrase.js — find where a line is spoken, without dumping every word.
 *
 * Authoring cut points needs the source-time of a handful of phrases, not a 600-row
 * word-by-word table. Give it the transcript and a snippet; it returns the {start,end}
 * of the best-matching contiguous run of words (source-time seconds, same clock as the
 * pack), plus a little context so you can trust the match.
 *
 * Usage:
 *   node phrase.js <transcript.json> "the phrase to find"
 *   node phrase.js <transcript.json> "phrase" --all      # every match, ranked
 *   node phrase.js <transcript.json> "phrase" --json      # machine-readable
 *   node phrase.js <transcript.json> --list               # sentence-level overview (~40 rows, cheap)
 *
 * Matching is token-based (punctuation/case-insensitive); the snippet need not be exact.
 */
import { readFileSync } from "node:fs";

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();
const toks = (s) => norm(s).split(" ").filter(Boolean);

function die(m) { console.error(`✗ ${m}`); process.exit(1); }

const [, , file, ...rest] = process.argv;
if (!file) die('usage: node phrase.js <transcript.json> "phrase" [--all|--json|--list]');
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const query = rest.filter((a) => !a.startsWith("--")).join(" ");

let tx;
try { tx = JSON.parse(readFileSync(file, "utf8")); } catch (e) { die(`can't read ${file}: ${e.message}`); }
const words = (tx.words || []).map((w) => ({ t: w.text, s: w.start / 1000, e: w.end / 1000 }));
if (!words.length) die("transcript has no word-level timings");

// --list: a cheap sentence-level overview (split on sentence-final punctuation in the text)
if (flags.has("--list")) {
  let buf = [], out = [];
  for (const w of words) {
    buf.push(w);
    if (/[.?!]$/.test(w.t)) { out.push(buf); buf = []; }
  }
  if (buf.length) out.push(buf);
  for (const sent of out) {
    const s = sent[0].s, e = sent[sent.length - 1].e;
    console.log(`${s.toFixed(2)}–${e.toFixed(2)}  ${sent.map((w) => w.t).join(" ")}`);
  }
  process.exit(0);
}

if (!query) die('give a phrase to find, or pass --list');
const q = toks(query);
const wt = words.map((w) => norm(w.t));

// Slide a window of the query length; score each window by token overlap in order.
const matches = [];
for (let i = 0; i + q.length <= wt.length; i++) {
  let hit = 0;
  for (let j = 0; j < q.length; j++) if (wt[i + j] === q[j]) hit++;
  if (hit >= Math.ceil(q.length * 0.6)) {
    matches.push({ i, score: hit / q.length, start: words[i].s, end: words[i + q.length - 1].e,
      text: words.slice(i, i + q.length).map((w) => w.t).join(" ") });
  }
}
matches.sort((a, b) => b.score - a.score || a.start - b.start);
if (!matches.length) die(`no match for "${query}" (try fewer / exact words)`);

if (flags.has("--json")) { console.log(JSON.stringify(flags.has("--all") ? matches : matches[0], null, 2)); process.exit(0); }
const show = flags.has("--all") ? matches : [matches[0]];
for (const m of show) {
  console.log(`${m.start.toFixed(2)}–${m.end.toFixed(2)}  (${Math.round(m.score * 100)}%)  ${m.text}`);
}
