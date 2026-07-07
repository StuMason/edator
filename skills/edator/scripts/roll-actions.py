#!/usr/bin/env python3
"""Roll metadata -> authoring action-map. Maps the event stream onto screen-pixel
focus rects so screen segments can be framed surgically (zoom to the clicked element).

Usage: roll-actions.py <recording-dir>
"""
import json, sys
from collections import Counter

if len(sys.argv) < 2:
    sys.exit("usage: roll-actions.py <roll-recording-dir>")
REC = sys.argv[1]
man = json.load(open(f"{REC}/manifest.json"))
ev = [json.loads(l) for l in open(f"{REC}/metadata.jsonl") if l.strip()]

# Per roll: ALL coords (cursor/click/drag/scroll x/y and ax.bounds) are ALREADY in
# screen.mp4 PIXEL space — local to the captured display, top-left origin, Y-down, and
# Retina-scaled. There is no origin to subtract and no global/local ambiguity. What varies
# is whether the pointer was on the captured display at all: values outside [0,w)×[0,h)
# (or a bound with a 0 dimension) mean the interaction happened on ANOTHER monitor — drop
# them. Normalise against the real screen.mp4 pixel dims (manifest.display.w/h are POINTS
# on Retina, so they'd be wrong to divide by).
def _screen_px():
    import subprocess
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", f"{REC}/screen.mp4"],
        capture_output=True, text=True)
    try:
        w, h = (int(v) for v in r.stdout.strip().split("x"))
        return w, h
    except Exception:
        return man["display"]["w"], man["display"]["h"]   # fallback: assume 1 px/pt
W, H = _screen_px()
print(f"# coords = screen.mp4 pixels ({W}x{H}); off-canvas (pointer on another display) is dropped")

def onscreen(x, y):                                     # was the pointer on the captured display?
    return x is not None and y is not None and 0 <= x < W and 0 <= y < H
def norm(x, y):                                         # screen px -> normalized focus 0..1
    return round(x / W, 3), round(y / H, 3)

def zoom_for_bounds(b, pad=1.6):
    """element [x,y,w,h] in screen px -> {scale,x,y} framing it with breathing room.
    A 0 in w/h (roll clips bounds to the viewport) means the element is off the captured
    frame — on another display — so it isn't framable. Returns None to skip."""
    x, y, w, h = b
    if w <= 0 or h <= 0:
        return None
    cx, cy = x + w/2, y + h/2
    if not onscreen(cx, cy):
        return None
    nx, ny = norm(cx, cy)
    # scale so the padded element width fits the frame, capped sane
    s = min(2.4, max(1.15, W / max(w * pad, 1)))
    return {"scale": round(s, 2), "x": nx, "y": ny}

# --- app/window context spine -------------------------------------------------
foc = [e for e in ev if e["type"] == "app_focus"]
print("=== CONTEXT SPINE (app focus) ===")
for i, e in enumerate(foc):
    end = foc[i+1]["t_ms"]/1000 if i+1 < len(foc) else man["durationMs"]/1000
    print(f"  {e['t_ms']/1000:6.1f}-{end:6.1f}s  [{e.get('app')}] {e.get('window','')[:50]}")

# --- clicks -> focus rects (only those on the captured display) ----------------
print("\n=== CLICK FOCUS POINTS (on captured display only) ===")
n_on = n_off = 0
for e in ev:
    if e["type"] != "click":
        continue
    pt = e.get("at") or e.get("to") or [e.get("x"), e.get("y")]
    px, py = (list(pt) + [None, None])[:2] if pt else (None, None)
    ax = e.get("ax") or {}
    win = (e.get("window") or e.get("app") or "")[:32]
    if not onscreen(px, py):                            # click landed on another monitor
        n_off += 1
        print(f"  {e['t_ms']/1000:6.1f}s  (off-canvas — other display, skipped) {win}")
        continue
    n_on += 1
    z = zoom_for_bounds(ax["bounds"]) if ax.get("bounds") else None
    pnx, pny = norm(px, py)
    print(f"  {e['t_ms']/1000:6.1f}s  click@({pnx},{pny}) {ax.get('role','')[:14]:14} {win}")
    if z: print(f"            -> zoom {z}")
print(f"  ({n_on} on captured display, {n_off} off-canvas)")

# --- activity density: 5s buckets, to spot live-demo vs waiting ----------------
print("\n=== ACTIVITY (events per 10s; <3 = waiting/dead, ramp or cut) ===")
dur = int(man["durationMs"]/1000) + 1
buckets = Counter()
for e in ev:
    if e["type"] == "cursor":   # cursor is noise; count intent only
        continue
    buckets[int(e["t_ms"]/1000//10)] += 1
for b in range(0, dur//10 + 1):
    n = buckets.get(b, 0)
    bar = "#" * min(n, 40)
    flag = "  << quiet" if n < 3 else ""
    print(f"  {b*10:4d}-{b*10+10:<4d}s  {n:3d} {bar}{flag}")
