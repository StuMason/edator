# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Finishing & delivery tools** — a stage after the cut, each runnable standalone:
  `captions.js` (SRT + VTT sidecars projected from the source transcript through the
  timeline), `loudness.js` (measure LUFS/true-peak; `--deliver` lands a peak-safe master
  with one static gain, no compression), `qc.js` (delivery QC sheet — LUFS, true-peak,
  bt709 colour tags, A/V-sync), and `phrase.js` (find a line's in/out without dumping
  every word).
- **Vertical reframe for shorts** (`reframe-focus.py` + bundled YuNet face model, and the
  `reframe` / `split` pack fields) — cover-crop a 16:9 source to 9:16 tracking the face, or
  stack screen-over-face with subs in the seam. Off by default; long-form unaffected.
- **bt709 colour tagging** on every encode (primaries/transfer/matrix + limited range) so
  graded blacks don't crush or wash on the viewer's player.
- **J/L cuts** — `audioLead` / `audioTrail` let a segment's audio lead or trail its picture.
- **Pre-flight media QC** (`preflight.js`) — the mirror of `report.js`: scores raw
  footage *before* a pack is written. Macro (freeze/black scan, variable frame rate,
  audio presence, clipping) + a **typed dead-air map** (leading/trailing/gap/pause/
  breath), projected onto the timeline so each landmine names the segments it hits.
  Silent-roll heuristic distinguishes camera death from a static screen-share.
- **Timeline moves** — per-segment `speed` (setpts + chained atempo, A/V locked),
  animated `zoom: "push"` / `{from,to}` (Ken Burns, via zoompan), and `chapter`
  markers → a YouTube-style sidecar.
- **Cut-boundary treatment** — automatic ~5ms **declick** on every join (default on),
  and `transition: "dip"` for a deliberate dip-to-black beat.
- **Bleeps** — per-segment `bleeps` censor a word: the speech is muted across the
  window and a gentle 1kHz tone drops in its place. Source-timed like captions and
  projected under `speed`. Tuned to sit *at* speech level — a casual swear gets a
  casual bleep, not a klaxon.
- **The raw escape valve** — `rawFilter` (per segment) + `output.rawVideoFilter` /
  `rawAudioFilter`: opaque ffmpeg *inside* the pack, so it still round-trips. Ungated
  but warns loudly — a feature-request funnel.
- **Validation** (`validate.js`) — semantic checks (always on, dep-free) + structural
  schema checks (ajv); the renderer refuses an invalid pack.
- **Scorecard + contact sheet** (`report.js`) — tightness / variety / correctness /
  ceiling, roll-balance, and a labelled contact sheet so you can *see* what the pack did.
- **Cross-platform fonts** — per-OS resolution with an `EDATOR_FONT` override.
- **Golden filter_complex snapshots + CI** — a regression ratchet over the renderer's
  graph; GitHub Actions runs the suite on every push/PR.
- **`references/personality.md`** — the EdAtor character + how to calibrate it to a
  presenter through feedback.

### Changed

- **Captions are now neutral by design** — the renderer burns only `plain` captions
  (positioned via `pos`); branded/animated overlays are a downstream-compositor concern,
  kept out of the generic renderer.

### Fixed

- **Animated `push` rendered invalid ffmpeg** — built a `crop` with a time-varying
  size (evaluated once at init, so rejected at render). Reimplemented with `zoompan`.

## [0.0.1] - 2026-06-25

- Initial public release: record once → Claude writes an edit pack → a deterministic
  FFmpeg renderer executes it. Cuts, roll-switching, audio bed, zoom, PiP, image
  B-roll, captions (editor / label / plain), music. Packaged as a Claude Code plugin.
