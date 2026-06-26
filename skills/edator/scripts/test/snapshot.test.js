import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

// Golden filter_complex snapshots — the regression ratchet.
//
// Each fixture pack is rendered with --dry-run and its filter_complex captured.
// The graph is machine-independent EXCEPT two paths: the resolved font and the
// caption temp files. We pin the fonts to committed fixture files (so they sit
// under <fixturesDir> and normalise away) and rewrite the caption temp path to a
// token. What's left is a stable fingerprint of the renderer's output for that
// pack — change the graph and the snapshot fails until you regenerate it.
//
//   regenerate:  GOLDEN=1 node --test test/snapshot.test.js
//   check:       node --test

const __dirname = dirname(fileURLToPath(import.meta.url));
const render = resolve(__dirname, "..", "render.js");
const fixturesDir = resolve(__dirname, "fixtures");
const packsDir = join(fixturesDir, "packs");
const goldenDir = resolve(__dirname, "golden");

// Pin fonts to committed fixture files so captions resolve identically on every
// OS. Both live under fixturesDir, so the normaliser collapses them to <FIX>.
const env = {
  ...process.env,
  EDATOR_FONT: join(fixturesDir, "font.ttf"),
  EDATOR_MONO: join(fixturesDir, "mono.ttf"),
};

function normalise(graph) {
  return graph
    .replaceAll(fixturesDir, "<FIX>")
    // caption temp files: textfile='/.../edator-cap-XXXXXX/cN.txt'  →  textfile='<CAP>/cN.txt'
    // [^']* keeps the match inside the quotes so it can't span the preceding fontfile path.
    .replace(/textfile='[^']*edator-cap-\w+\/(c\d+\.txt)'/g, "textfile='<CAP>/$1'");
}

function graphFor(packPath) {
  const r = spawnSync("node", [render, packPath, "--dry-run"], { encoding: "utf8", env });
  assert.equal(r.status, 0, `${basename(packPath)} dry-run failed:\n${r.stderr}`);
  const marker = "--- filter_complex ---\n";
  const i = r.stdout.indexOf(marker);
  assert.ok(i !== -1, `${basename(packPath)}: no filter_complex in dry-run output`);
  return normalise(r.stdout.slice(i + marker.length).trim());
}

const packs = readdirSync(packsDir).filter((f) => f.endsWith(".json")).sort();
assert.ok(packs.length > 0, "no fixture packs found");

if (process.env.GOLDEN) {
  if (!existsSync(goldenDir)) mkdirSync(goldenDir, { recursive: true });
  for (const p of packs) {
    const name = basename(p, ".json");
    writeFileSync(join(goldenDir, `${name}.txt`), graphFor(join(packsDir, p)) + "\n");
  }
}

for (const p of packs) {
  const name = basename(p, ".json");
  test(`filter_complex snapshot: ${name}`, () => {
    const goldenPath = join(goldenDir, `${name}.txt`);
    assert.ok(existsSync(goldenPath), `missing golden for ${name} — run: GOLDEN=1 node --test`);
    const golden = readFileSync(goldenPath, "utf8").trim();
    const actual = graphFor(join(packsDir, p));
    assert.equal(actual, golden, `graph drifted for ${name}. If intentional, regenerate: GOLDEN=1 node --test`);
  });
}
