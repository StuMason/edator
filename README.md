# Edator

**Record once. Claude decides the cut. FFmpeg executes it.**

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
- **Roll-switching** — each segment picks which roll is visible (e.g. screen ↔ camera).
- **Audio bed** — one source's audio plays continuously while the video switches above it.
- **Zoom punch-ins** — emphasis zoom, with a focus point.
- **Picture-in-picture** — drop a roll into a corner (e.g. the camera over a diagram).
- **Image B-roll** — hold a still (diagram / card) full-frame while narration continues.
- **Captions** — three styles: an EdAtor chat-bubble aside, a production eyebrow label, or a plain caption.
- **Music** — a quiet continuous bed, or a faded intro/outro bookend.
- **Warm audio** — a gentle, transparent polish (and a strong opinion about *not* over-processing a good mic).

See the example: [`examples/edit-pack.example.json`](examples/edit-pack.example.json).

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

- `skills/edator/` — the skill (`SKILL.md`), the renderer + transcription scripts (`scripts/`), and references (schema, style guide, OBS setup)
- `examples/` — a worked edit-pack template exercising every feature
- `.claude-plugin/` — plugin manifest + marketplace catalog

## Status

`v0.0.1` — early, and honest about it. The full loop works end-to-end on real
footage: record → transcribe → Claude writes a pack → render. The renderer is
proven frame-accurate. Coming: a tighter one-shot, animated/kinetic additions, and
pushing the renderer to a server (upload pack → download MP4).

## License

[MIT](LICENSE) © Stu Mason
