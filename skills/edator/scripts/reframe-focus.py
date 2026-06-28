#!/usr/bin/env python3
"""
Edator — reframe focus solver.

Computes WHERE to crop when a 16:9 roll is cover-cropped to a different aspect
(e.g. 9:16 vertical). Instead of guessing "centre", it looks at the footage:

  --role face   : YuNet face detection (OpenCV's built-in detector). Samples
                  frames across the beat, returns the median face centre. Keeps
                  the speaker in frame even if they drift left/right.
  --role screen : temporal change-heatmap. Frame-differences sampled frames and
                  returns the centroid of motion — where the cursor/typing/window
                  activity actually is. Crops to the action, not the middle.

Output is a normalised focus point {x, y} in 0..1, ready to drop into a pack
segment's  "reframe": {"mode": "cover", "x": .., "y": ..}.  Low confidence (no
face found / a static screen) falls back to centre AND says so — it never
silently guesses.

Usage:
  reframe-focus.py <roll.mp4> --in <sec> --out <sec> --role face|screen [--samples N] [--json]

Needs: opencv-python (cv2), numpy. The YuNet model lives next to this script in
models/face_detection_yunet_2023mar.onnx (face role only).
"""
import argparse, json, os, sys
import numpy as np
import cv2

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "models", "face_detection_yunet_2023mar.onnx")


def die(msg):
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def sample_times(t_in, t_out, n):
    """Evenly spaced sample timestamps, kept just inside the range."""
    if t_out <= t_in:
        die(f"--out ({t_out}) must be greater than --in ({t_in})")
    pad = (t_out - t_in) * 0.04
    a, b = t_in + pad, t_out - pad
    return [a + (b - a) * i / max(1, n - 1) for i in range(n)]


def grab(cap, t):
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
    ok, frame = cap.read()
    return frame if ok else None


def solve_face(cap, w, h, times):
    if not os.path.exists(MODEL):
        die(f"YuNet model not found: {MODEL}")
    det = cv2.FaceDetectorYN.create(MODEL, "", (w, h), score_threshold=0.6)
    det.setInputSize((w, h))
    centres = []
    for t in times:
        frame = grab(cap, t)
        if frame is None:
            continue
        _, faces = det.detect(frame)
        if faces is None or len(faces) == 0:
            continue
        # Highest-confidence face (last column is the score); x,y,w,h are 0..3.
        f = max(faces, key=lambda r: r[-1])
        cx = (f[0] + f[2] / 2.0) / w
        cy = (f[1] + f[3] / 2.0) / h
        centres.append((cx, cy))
    if len(centres) < max(2, len(times) // 3):
        return 0.5, 0.5, len(centres) / len(times), "face-fallback-centre"
    arr = np.array(centres)
    # Median is robust to a stray mis-detection.
    return float(np.median(arr[:, 0])), float(np.median(arr[:, 1])), \
        len(centres) / len(times), "face-median"


def solve_screen(cap, w, h, times):
    """Centroid of inter-frame change — where the action is on screen."""
    prev = None
    accum = None
    used = 0
    for t in times:
        frame = grab(cap, t)
        if frame is None:
            continue
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        g = cv2.GaussianBlur(g, (21, 21), 0)
        if prev is not None:
            d = cv2.absdiff(g, prev).astype(np.float32)
            accum = d if accum is None else accum + d
            used += 1
        prev = g
    if accum is None or used == 0 or float(accum.sum()) < 1e-3:
        return 0.5, 0.5, 0.0, "screen-fallback-centre-static"
    total = float(accum.sum())
    ys, xs = np.mgrid[0:accum.shape[0], 0:accum.shape[1]]
    cx = float((accum * xs).sum() / total) / w
    cy = float((accum * ys).sum() / total) / h
    # Confidence ~ how concentrated the motion is (lower spread = more confident).
    spread = float(np.sqrt(((accum * ((xs / w - cx) ** 2 + (ys / h - cy) ** 2)).sum()) / total))
    conf = max(0.0, min(1.0, 1.0 - spread * 2))
    return cx, cy, conf, "screen-motion-centroid"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("roll")
    ap.add_argument("--in", dest="t_in", type=float, required=True)
    ap.add_argument("--out", dest="t_out", type=float, required=True)
    ap.add_argument("--role", choices=["face", "screen"], required=True)
    ap.add_argument("--samples", type=int, default=14)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.roll):
        die(f"roll not found: {args.roll}")
    cap = cv2.VideoCapture(args.roll)
    if not cap.isOpened():
        die(f"could not open: {args.roll}")
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    times = sample_times(args.t_in, args.t_out, args.samples)

    if args.role == "face":
        x, y, conf, method = solve_face(cap, w, h, times)
    else:
        x, y, conf, method = solve_screen(cap, w, h, times)
    cap.release()

    out = {"role": args.role, "x": round(x, 4), "y": round(y, 4),
           "confidence": round(conf, 3), "method": method,
           "roll": os.path.basename(args.roll),
           "in": args.t_in, "out": args.t_out, "source_dims": [w, h]}
    if args.json:
        print(json.dumps(out))
    else:
        print(f"{args.role:7} x={out['x']:.3f} y={out['y']:.3f} "
              f"conf={out['confidence']:.2f} [{method}] "
              f"({args.t_in:.1f}–{args.t_out:.1f}s, {w}x{h})")


if __name__ == "__main__":
    main()
