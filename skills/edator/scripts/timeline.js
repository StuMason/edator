/**
 * Edator — the timeline mapping, shared by every tool that has to agree about
 * where a moment lands: the renderer (which trims/concats/speed-changes), the
 * pre-flight QC (which projects freeze/silence windows onto the cut) and, later,
 * caption projection. One definition so they can never drift apart.
 *
 * Everything speaks in SECONDS, across two clocks:
 *   source time — where something sits inside an original recording
 *   output time — where it lands in the finished cut, after segments are
 *                 dropped, reordered and speed-changed
 */

// A segment's duration on the OUTPUT clock: its source span over any speed.
export function segOutDur(seg) {
  return +((seg.end - seg.start) / (seg.speed || 1)).toFixed(3);
}

// Which source is actually HEARD during a segment: a per-segment override wins,
// then the global bed, then the segment's own roll.
export function segAudioKey(seg, pack) {
  return seg.audio || pack.audio || seg.source;
}
