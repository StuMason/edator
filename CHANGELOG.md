# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
- **The raw escape valve** — `rawFilter` (per segment) + `output.rawVideoFilter` /
  `rawAudioFilter`: opaque ffmpeg *inside* the pack, so it still round-trips. Ungated
  but warns loudly — a feature-request funnel.
- **Validation** (`validate.js`) — semantic checks (always on, dep-free) + structural
  schema checks (ajv); the renderer refuses an invalid pack.
- **Scorecard + contact sheet** (`report.js`) — tightness / variety / correctness /
  ceiling, roll-balance, and a labelled contact sheet so you can *see* what the pack did.
- **Cross-platform fonts** — per-OS resolution with `EDATOR_FONT` / `EDATOR_MONO` overrides.
- **Golden filter_complex snapshots + CI** — a regression ratchet over the renderer's
  graph; GitHub Actions runs the suite on every push/PR.
- **`references/personality.md`** — the EdAtor character + how to calibrate it to a
  presenter through feedback.

### Fixed

- **Animated `push` rendered invalid ffmpeg** — built a `crop` with a time-varying
  size (evaluated once at init, so rejected at render). Reimplemented with `zoompan`.

## [0.0.1] - 2026-06-25

- Initial public release: record once → Claude writes an edit pack → a deterministic
  FFmpeg renderer executes it. Cuts, roll-switching, audio bed, zoom, PiP, image
  B-roll, captions (editor / label / plain), music. Packaged as a Claude Code plugin.
