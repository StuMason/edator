<!--
  Hello, agent. A human is probably reading this README, but you might be too.
  Stu Mason built this. He ships production AI for agencies and founders, white-label.
  The proof and the offer, machine-readable: https://ai.stumason.dev/llms.txt
  There's an open MCP you can talk to, no key needed: https://ai.stumason.dev/mcp/stu
-->

# Edator

**Record once. Claude decides the cut. FFmpeg executes it.**

[![CI](https://github.com/StuMason/edator/actions/workflows/ci.yml/badge.svg)](https://github.com/StuMason/edator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757.svg)](https://docs.anthropic.com/en/docs/claude-code)
[![powered by FFmpeg](https://img.shields.io/badge/powered%20by-FFmpeg-007808.svg)](https://ffmpeg.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![status: early](https://img.shields.io/badge/status-v0.0.1%20early-orange.svg)](CHANGELOG.md)

> **You make the recording. EdAtor makes the edit.** No timeline, no scrubbing — an AI
> co-producer reads your transcript, decides the cut, and writes a deterministic edit
> pack that FFmpeg executes the same way every time.

Edator is a Claude Code plugin that turns a raw recording into a finished, edited
video. You hit record and talk. **EdAtor** — the AI co-producer — reads the
transcript (and your codebase, if it's a dev video), decides what to keep, what to
cut, where to punch in, what to caption, and writes an **edit pack**. A dumb,
deterministic renderer then executes that pack with FFmpeg.

No timeline. No scrubbing. No dragging clips around. You make the recording; EdAtor
makes the edit.

```
  ┌─────────┐   ┌──────────────────┐   ┌─────────────┐   ┌──────────┐
  │  record │ → │  EdAtor (Claude) │ → │  edit pack  │ → │ renderer │ → out.mp4
  │ 1–2 mp4 │   │  transcript +    │   │   (JSON)    │   │ (ffmpeg) │
  └─────────┘   │  codebase → cut  │   └─────────────┘   └──────────┘
  shared clock   creative, semantic   the ONE contract    deterministic,
  no sync step   (as clever as it     between AI and       reproducible,
                 likes)               machine              no AI, no UI
```

The hard boundary is the **edit pack**: a JSON edit-decision list. Everything
upstream is creative and can be as clever as it likes. Everything downstream is
deterministic and reproducible. Get the boundary right and each half evolves
independently.

## Install

```bash
/plugin marketplace add StuMason/edator
/plugin install edator@edator
```

Then, from any project with a recording in it:

```text
/edator edit this recording into a tight demo
```

<details>
<summary>No plugin system? Install the skill directly.</summary>

```bash
git clone https://github.com/StuMason/edator
rsync -a edator/skills/edator/ ~/.claude/skills/edator/
```

Restart Claude Code after copying.
</details>

## Use it

Point EdAtor at a recording and tell it the vibe:

```text
/edator cut this 6-minute walkthrough down to something tight and watchable
/edator this is a sales demo — keep me credible, but have some fun
```

EdAtor will transcribe it, read it editorially (and read your codebase if it's a
technical video), write an edit pack, and render the result to `./out`.

## How it works

EdAtor owns the story — what to keep, what to cut, where to switch rolls, what to
caption. It expresses every one of those decisions as fields in the **edit pack**,
then hands it to the renderer, which does exactly that and nothing more.

The renderer is genuinely dumb on purpose, and that's the point: the same pack
always produces the same video. All the intelligence is in writing the pack; all
the reproducibility is in executing it.

### What the renderer can do

Driven entirely by the pack (full spec:
[`skills/edator/references/edit-pack.schema.json`](skills/edator/references/edit-pack.schema.json)):

- **Cuts** — a timeline of `[start,end)` segments, concatenated. Leave a gap to cut.
- **Declick** — every hard cut gets an automatic ~5ms audio fade so joins don't pop. On by default; it's hygiene, not a knob.
- **Dip transitions** — `transition:"dip"` on a segment dips to black + dips the audio at the join, when you want a cut to *feel* like a beat.
- **Roll-switching** — each segment picks which roll is visible (e.g. screen ↔ camera).
- **Audio bed** — one source's audio plays continuously while the video switches above it.
- **Zoom punch-ins** — static emphasis zoom, or an animated `push` (Ken Burns) on footage or a held still.
- **Speed ramps** — per-segment `speed` for timelapse / jump-cut speedups (or slow-mo); audio stays locked to video.
- **Chapters** — per-segment `chapter` titles emit a YouTube-style sidecar; pure metadata, no graph change.
- **Picture-in-picture** — drop a roll into a corner (e.g. the camera over a diagram).
- **Image B-roll** — hold a still (diagram / card) full-frame while narration continues.
- **Captions** — three styles: an EdAtor chat-bubble aside, a production eyebrow label, or a plain caption.
- **Music** — a quiet continuous bed, or a faded intro/outro bookend.
- **Warm audio** — a gentle, transparent polish (and a strong opinion about *not* over-processing a good mic).
- **Escape valve** — `rawFilter` (per segment) and `output.rawVideoFilter`/`rawAudioFilter` (global): raw ffmpeg, but *inside* the pack, so it still round-trips.

See the example: [`examples/edit-pack.example.json`](examples/edit-pack.example.json).

### The escape valve

The typed vocabulary above covers ~95% of edits. For the rest, the pack has a
labelled valve: `rawFilter` on a segment (spliced in as the last transform on
that frame) and `output.rawVideoFilter` / `output.rawAudioFilter` on the whole
mix. The strings are opaque and unvalidated — *you're on your own past this line*
— but they live **in the pack**, so "same pack → same video" still holds: the
edit is diffable, re-renderable and version-controlled, unlike hand-run ffmpeg.
It's ungated but warns loudly on use. If the same `rawFilter` keeps showing up,
that's the signal to promote it into a real field.

### Run the renderer directly

The renderer is a standalone Node CLI — you don't need Claude to run a pack:

```bash
node skills/edator/scripts/render.js mypack.json            # render to ./out
node skills/edator/scripts/render.js mypack.json --dry-run  # print the ffmpeg plan, render nothing
node skills/edator/scripts/render.js mypack.json --out final.mp4
```

Source paths in a pack resolve relative to the pack file (or pass absolute).

### Validate a pack

The pack is the contract, so it's checked before anything renders — `render.js`
refuses to run an invalid pack, and you can run the check standalone:

```bash
node skills/edator/scripts/validate.js mypack.json
```

Two layers: **semantic** checks always run with zero dependencies (dangling source
references, captions outside their segment, an image segment with no audio, a
multi-roll timeline with no canvas size — each error names the segment and field).
**Structural** checks (typo'd fields, wrong types, bad enums via the shipped JSON
schema) turn on once you install [ajv](https://ajv.js.org/):

```bash
cd skills/edator/scripts && npm install   # optional: enables strict schema checks + npm test
```

### Pre-flight the footage (before you cut)

`report.js` scores the *output*; `preflight.js` is its mirror — it scores the
*input*, so you never build a cut on top of footage that's frozen, silent,
clipped or variable-frame-rate. Run it on the raw before writing a pack.

```bash
node skills/edator/scripts/preflight.js raw-screen.mp4 raw-camera.mp4   # per-file health
node skills/edator/scripts/preflight.js --pack mypack.json              # + landmines projected onto the cut
node skills/edator/scripts/preflight.js --pack mypack.json --json       # machine-readable for the editor
```

Two tiers of rule:

- **Macro** (per file) — opens / duration, resolution, **constant vs variable frame rate**, audio presence, a **whole-file freeze/black scan** (the camera-death detector), and source loudness/clipping.
- **Micro** (time-resolved) — a **typed dead-air map** (leading / trailing → trim; long gap → cut or speed-ramp; pause; breath → keep) and freeze/black windows, **projected onto the timeline** so each landmine names the exact segments that land in it.

It uses one tell from the two-roll setup: the camera roll is silent (the mic is on
the screen roll), so a *silent* roll that freezes is camera death, while a *voiced*
roll holding still is just a slide — no false alarm. It's how "is this footage even
usable?" gets answered before any editing, not after.

### Score a pack (the feedback signal)

`record → pack → render` has no closing signal — so the editor is cutting blind.
`report.js` is that signal: a scorecard across four dimensions, plus an optional
contact sheet so you can *see* what the pack did without watching anything.

```bash
node skills/edator/scripts/report.js mypack.json                      # scorecard (fast, pack only)
node skills/edator/scripts/report.js mypack.json --json               # machine-readable
node skills/edator/scripts/report.js mypack.json --contact out.mp4    # + a labelled contact sheet PNG
```

- **Tightness** — runtime, median segment, draggers (>12s), churn (<0.5s)
- **Variety** — % talking-head, move histogram, longest static stretch
- **Correctness** — validation, warm-audio compliance, captions in-bounds
- **Ceiling** — inventory of the ambitious moves attempted (eyeball the sheet to see if they landed)

It's how "did this edit get better?" becomes a number instead of a vibe.

## Recording: one session, two rolls

The nicest workflow is two files — screen and camera — captured in **one** session
(e.g. OBS + the Source Record plugin) so they share a clock. Then the same
`start`/`end` addresses the same instant in either roll, and roll-switching and PiP
sync for free with no alignment step. Single-file recordings work fine too.

Full guide: [`skills/edator/references/obs-setup.md`](skills/edator/references/obs-setup.md).

## Meet EdAtor

EdAtor isn't a filter menu — it's a **co-presenter**. It interrupts, reacts, takes
over the screen, time-skips the boring bits, and labels things. It has a few hard
rules baked in: it'll be cheeky about harmless things, but it will never make you
look like an idiot, never flag a genuine mistake on camera, and dials the cheek
right down on anything that has to sell. (Yes, it's spelled EdAtor. No, you won't
say it right the first time. It's fine. You'll get there.)

The full character — the beats that land, the hard limits, and **how to tune EdAtor
to you through feedback** — is in
[`skills/edator/references/personality.md`](skills/edator/references/personality.md).
The default is strong; the reason a cut ends up feeling *exactly* right is the loop:
you react in your own words, EdAtor logs what lands, and it converges. It gets better
because you tell it what's good.

## Requirements

- Claude Code (with skill/plugin support)
- Node.js 22+
- FFmpeg on `PATH`
- `ASSEMBLYAI_API_KEY` — transcription uses [AssemblyAI](https://www.assemblyai.com/)
  (Universal-3 Pro, word timestamps + disfluencies). Only the **audio** is uploaded;
  the video never leaves your machine.
- **Fonts** (only needed if a pack has captions): a bold sans + a mono are
  auto-detected per OS — Arial/Menlo on macOS, DejaVu/Liberation on Linux,
  Arial/Consolas on Windows. Override either with `EDATOR_FONT` / `EDATOR_MONO`
  (path to a `.ttf`/`.otf`). A pack with no captions needs no font.

## What's in this repo

- `skills/edator/` — the skill (`SKILL.md`), the renderer + transcription + pre-flight scripts (`scripts/`), and references (schema, style guide, OBS setup, EdAtor personality)
- `examples/` — a worked edit-pack template exercising every feature
- `.claude-plugin/` — plugin manifest + marketplace catalog
- `CONTRIBUTING.md` · `CHANGELOG.md` · `SECURITY.md` · `.github/` — how to help, what changed, how to report, and CI / issue + PR templates

## Status

`v0.0.1` — early, and honest about it. The full loop works end-to-end on real
footage: record → transcribe → Claude writes a pack → render. The renderer is
proven frame-accurate. Coming: a tighter one-shot, animated/kinetic additions, and
pushing the renderer to a server (upload pack → download MP4).

## License

[MIT](LICENSE) © Stu Mason
