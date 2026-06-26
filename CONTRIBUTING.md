# Contributing to Edator

Thanks for poking at this. Edator is small, opinionated, and dependency-light on
purpose. Here's how it fits together and how to add to it without breaking the one
thing that matters: **the same pack always renders the same video.**

## The shape of it

```
skills/edator/
  SKILL.md            the editor persona + the process (record → pack → render)
  references/         the contract (schema), the brand (style), the character
                      (personality), the capture guide (obs-setup)
  scripts/
    render.js         the deterministic renderer — turns a pack into an mp4
    preflight.js      media QC over raw footage (the mirror of report.js)
    validate.js       enforces the pack contract (semantic always-on + ajv)
    report.js         the scorecard + contact sheet (scores the output)
    transcribe.js     audio → word-level transcript (AssemblyAI)
    envelope.js       speech-onset detection (the "waveform" you cut to)
    timeline.js       the shared source↔output mapping (renderer + preflight agree)
    test/             node:test suite, incl. golden filter_complex snapshots
```

The **edit pack** (`references/edit-pack.schema.json`) is the hard boundary.
Everything upstream is creative; everything downstream is deterministic. Changes
should respect that line.

## Running it

```bash
cd skills/edator/scripts
npm install        # optional — enables ajv (strict schema checks) + the test deps
node --test        # the full suite (semantic/structural validation, scorecard,
                   # fonts, the golden snapshots)
```

`render.js` and `preflight.js` need **ffmpeg** on `PATH`; `transcribe.js` needs
`ASSEMBLYAI_API_KEY` (env var or a `.env` in the working dir). Only **audio** ever
leaves the machine — the video does not.

## The golden snapshots, and their one blind spot

`test/snapshot.test.js` renders each fixture pack with `--dry-run` and compares the
`filter_complex` to a committed golden. If you change the graph on purpose:

```bash
GOLDEN=1 node --test    # regenerate; the diff IS your change — review it
```

**Important:** goldens prove the graph is *stable*, not that ffmpeg *accepts* it.
A push field once shipped with a `crop` that had a time-varying size — string-valid,
render-invalid. If you add a move, **render it against real media** before you trust
it. (A render-smoke check is on the roadmap for when CI can carry ffmpeg + a clip.)

## Adding a timeline move

1. House rule: **scalar shorthand OR object**, never a required object — keep the
   common case one token (`zoom: number | {…}`).
2. Add it to the schema (`additionalProperties:false` means typos are caught — so a
   new field must be declared).
3. Implement in `render.js`; add a fixture + snapshot + a behaviour test.
4. If it can't be a typed field yet, it's a `rawFilter` — and recurring rawFilter
   usage is the signal to promote it.

## Maintenance

- **CI** (`.github/workflows/ci.yml`) runs `npm install` + a syntax check + the
  suite on every push/PR (Ubuntu, Node 22). Keep it green.
- **Dependabot** keeps `ajv` and the Actions current (weekly, grouped).
- Code should read like the code around it — match the comment density and idiom.

PRs welcome. Small, focused, tested.
