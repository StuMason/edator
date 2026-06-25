# OBS setup for Edator (macOS) — two-roll recording

The most important decision in this project: **solve source sync at the recording
stage, not the edit stage.** We record **two full-resolution rolls — screen and
camera — from ONE OBS session.** Because they share one clock and start frame,
they're aligned by construction. No drift, no alignment maths. (That nightmare
only happens with *independent* recorders on different clocks.)

Why two rolls instead of one composited file: editorial freedom. You decide in
the edit when to show full screen, full face, or a picture-in-picture corner —
the framing isn't baked in at record time.

```
session/
  screen.mp4    full screen  + mixed audio (mic + system)   ← main OBS recording
  camera.mp4    full camera  (video; audio ignored)         ← Source Record filter
                ^ same start frame — one session, one clock
```

Audio lives in **one continuous track on `screen.mp4`**. In the edit we keep that
audio bed running and just swap which *video* roll is on screen. That's how real
multicam cuts work.

---

## 1. Prerequisites

- OBS 30+ (`brew install --cask obs`). Already installed here (32.x).
- **Source Record** plugin by Exeldro — OBS can only record one canvas natively;
  this filter records an individual source to its own file. Install the
  **universal** macOS `.pkg` from
  <https://github.com/exeldro/obs-source-record/releases>. Quit OBS first; an
  unsigned pkg installs most reliably via:
  `sudo installer -pkg <file>.pkg -target /`

On first launch grant OBS **Screen Recording**, **Camera**, **Microphone** in
System Settings → Privacy & Security.

---

## 2. Video & audio (Settings)

> ⚠️ **Performance (read this).** Two rolls = two simultaneous H.264 encodes. On
> older / Intel Macs this is heavy. A 2018 i7-8850H pushing 2560×1440 @ 60fps
> *dropped ~97% of frames* — unusable. Keep the load down: **1080p, 30fps,
> hardware encoder for BOTH outputs, camera roll scaled to 720p** (settings
> below). If OBS still reports skipped/lagged frames in its log after recording,
> drop further or fall back to a single composited file (one encode).

**Video:**
- Base (Canvas) Resolution = **1920×1080** (1080p is sharp enough for screen text;
  only go higher if your machine has headroom to spare)
- Output (Scaled) Resolution = same as base
- FPS = **30** (never 60 for talking-head/screen — it doubles encode load)

**Audio:**
- Sample Rate = **48 kHz**, Channels = Stereo

**Output** → switch *Output Mode* to **Advanced** → **Recording** tab:
- Recording Path = `~/Code/tools/edator/recordings`
- Recording Format = **`hybrid MP4`** (or `fragmented MP4`). NEVER plain `mp4` —
  it corrupts the whole file if OBS crashes mid-record. (Or record `mkv` and
  File → Remux Recordings → mp4 afterwards.)
- Video Encoder = **Apple VT H264 Hardware** — NOT x264/software (software melts
  older CPUs; the hardware QuickSync block can run two streams).
- Quality ≈ visually lossless (CRF ~18). The renderer re-encodes on export anyway.
- Audio Track = Track 1
- **Mic gain:** watch the Audio Mixer peak around −12 to −6 dB as you talk. The
  first test was too quiet (max −24 dB) — turn it up.

---

## 3. Sources (one scene)

Add to a single scene:

1. **Screen** — `+ → macOS Screen Capture` → your display. It fills the canvas, so
   it *is* the main `screen.mp4` recording. Enable its **audio capture** if you
   want system/app sound mixed in.
2. **Mic** — `+ → Audio Input Capture` → your microphone.
3. **Camera** — `+ → Video Capture Device` → your webcam. Then **drag it
   completely OUTSIDE the canvas** (into the grey area). It stays *active* (so we
   can record it) but won't appear in `screen.mp4`.

---

## 4. The Source Record filter (the second roll)

Right-click the **camera** source → **Filters** → **+** → **Source Record**:

- **Path:** `~/Code/tools/edator/recordings`
- **Filename Formatting:** something like `camera-%CCYY-%MM-%DD-%hh-%mm-%ss`
- **Record Mode:** **`Recording`** ← critical. This ties the camera file to the
  main Record button, so both rolls start and stop on the same frame = synced.
- **Resolution / Scale:** **1280×720** — it's a face, doesn't need 1080p, and
  downscaling here is the single biggest saving on a weaker machine.
- **Encoder:** Apple VT H264 Hardware (not software).

Close the filter dialog. Done — one Record button now writes both files.

> Tip: also rename the main recording to start with `screen-` (Settings → Output →
> Recording filename formatting) so each session's two files sit together
> alphabetically.

---

## 5. Recording workflow

1. **Start Recording.**
2. **Make mistakes freely.** Fluffed a line? Say *"let me start that again"* out
   loud and redo it — don't stop. Those verbal markers are exactly what Claude
   greps the transcript for to cut botched takes.
3. **Stop Recording.**
4. You'll have `screen-*.mp4` and `camera-*.mp4` in `recordings/`. (Remux from
   mkv first if you recorded mkv.)

---

## Sanity check

Confirm both rolls are clean and the same length:

```bash
cd ~/Code/tools/edator/recordings
for f in screen-*.mp4 camera-*.mp4; do
  echo "$f:"; ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name \
    -of default=nw=1 "$f"; echo
done
```

`screen.mp4` should have one video + one audio stream; `camera.mp4` one video
stream. Durations should match within a frame or two.
