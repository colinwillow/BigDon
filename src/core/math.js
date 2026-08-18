// Small math helpers. Everything here is frame-rate independent where it
// matters — the `damp` family takes dt and a half-life, never a raw per-frame
// lerp factor, because constant-factor lerps judder the instant frame times vary.
//
// Ported from Peggy, which got these right the hard way.

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Shortest signed delta from angle `a` to angle `b`. */
export function angleDelta(a, b) {
  return wrapAngle(b - a);
}

/**
 * Frame-rate independent exponential approach.
 * `hl` is the half-life in seconds: after `hl` seconds, half the remaining
 * distance is gone, regardless of how many frames it took to get there.
 */
export function damp(current, target, hl, dt) {
  if (hl <= 0) return target;
  return target + (current - target) * Math.pow(2, -dt / hl);
}

/** damp() along the shortest path around the circle. */
export function dampAngle(current, target, hl, dt) {
  return current + angleDelta(current, target) * (1 - Math.pow(2, -dt / hl));
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveToward(current, target, maxDelta) {
  const d = target - current;
  return Math.abs(d) <= maxDelta ? target : current + sign(d) * maxDelta;
}

/** Move an ANGLE toward a target by at most `maxDelta`, shortest way round. */
export function moveTowardAngle(current, target, maxDelta) {
  const d = angleDelta(current, target);
  return Math.abs(d) <= maxDelta ? wrapAngle(target) : wrapAngle(current + sign(d) * maxDelta);
}

/** Deterministic-ish random in a range. */
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
