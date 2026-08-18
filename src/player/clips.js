// Which of the GLB's 72 baked tracks drives which part of the locomotion.
//
// Every clip in this model is IN-PLACE — the hips track is a two-key constant,
// so no clip translates the character. That is exactly what a twin-stick game
// wants: code owns the movement, the clip owns the pose, and the two never
// fight. (Root-motion clips would have to be sampled and their delta fed back
// into the controller, which is a different and much fussier design.)
//
// Names here are the raw track names from the GLB. Swap any value to audition a
// different take — the debug panel's clip browser lists all 72.

export const CLIPS = {
  // ── the locomotion blend tree ────────────────────────────────────────────
  // Four directions x two speed tiers, plus idle. The blender picks the two
  // cardinals either side of the movement direction and crossfades them, then
  // crossfades that result between the walk and run tiers by speed.
  idle: 'idle',

  walkF: 'walking',
  walkB: 'standing_walk_back',
  walkL: 'left_strafe_walking',
  walkR: 'right_strafe_walking',

  runF: 'running',
  runB: 'standing_run_back',
  runL: 'left_strafe',
  runR: 'right_strafe',

  // ── air ──────────────────────────────────────────────────────────────────
  jumpUp: 'jumping_up',      // 0.27s — the takeoff pop
  fall: 'falling_idle',      // 0.73s — the air loop
  land: 'hard_landing',      // 2.03s — trimmed by landFade below
  landRoll: 'falling_to_roll',

  // ── one-shots ────────────────────────────────────────────────────────────
  dash: 'falling_to_roll',   // left-stick flick; see dashStart
  melee: 'standing_melee_attack_horizontal',
  meleeCombo: [
    'standing_melee_attack_horizontal',
    'standing_melee_attack_backhand',
    'standing_melee_attack_downward',
  ],

  // ── turn in place ────────────────────────────────────────────────────────
  turnL: 'left_turn_90',
  turnR: 'right_turn_90',
};

/**
 * Per-clip tuning. Everything the raw Mixamo take gets wrong for this game.
 *
 * `phase` shifts a locomotion clip's cycle so its footfalls line up with the
 * others in its tier — the four strafe takes were authored independently and
 * do not start on the same foot, which reads as a hitch when the blend swings
 * between them. Expressed in cycles (0..1).
 *
 * `start` skips dead time at the head of a one-shot. `falling_to_roll` spends
 * its first third in the air before it ever touches the ground, so a dodge roll
 * that plays it from zero looks like the character hesitates.
 */
export const CLIP_TUNING = {
  walking:              { phase: 0.00 },
  standing_walk_back:   { phase: 0.00 },
  left_strafe_walking:  { phase: 0.50 },
  right_strafe_walking: { phase: 0.00 },

  running:              { phase: 0.00 },
  standing_run_back:    { phase: 0.00 },
  left_strafe:          { phase: 0.50 },
  right_strafe:         { phase: 0.00 },

  falling_to_roll:      { start: 0.62, timeScale: 1.35 },
  hard_landing:         { timeScale: 1.6 },
  jumping_up:           { timeScale: 1.0 },
};

/** Movement + feel constants. Tunable live from the debug panel. */
export const TUNING = {
  // ── speeds, in metres/sec ────────────────────────────────────────────────
  // The walk/run split is a stick-deflection threshold, not two buttons: ease
  // the thumb out and he walks, push past `runAt` and he commits to a run.
  walkSpeed: 1.7,
  runSpeed: 5.0,
  runAt: 0.72,          // stick deflection above which we're running

  accel: 22,            // m/s^2 — how hard he gets up to speed
  decel: 26,            // m/s^2 — and how hard he stops
  airControl: 0.35,     // fraction of ground accel available mid-air

  // Turn rate is deliberately fast but not instant. Instant turning reads as
  // the model teleporting between facings; too slow and the stick feels laggy.
  turnRate: 13.0,       // rad/sec when moving
  turnRateAim: 18.0,    // ...and when the aim stick owns the facing

  // ── jump ─────────────────────────────────────────────────────────────────
  jumpSpeed: 6.2,       // m/s launch — with gravity below, ~1.0m and ~0.9s
  gravity: 20.0,
  coyoteTime: 0.10,     // still jumpable this long after walking off an edge
  jumpBuffer: 0.14,     // a jump pressed this soon before landing still fires

  // ── dash / roll (left-stick flick) ───────────────────────────────────────
  dashSpeed: 9.5,
  dashDuration: 0.42,
  dashCooldown: 0.34,

  // ── animation blending ───────────────────────────────────────────────────
  // Half-lives in seconds. Locomotion weights are smoothed rather than snapped
  // so a direction change crossfades instead of popping.
  blendHL: 0.075,
  oneShotIn: 0.06,      // one-shots come in fast — a melee must feel immediate
  oneShotOut: 0.16,     // ...and leave gently, back into the locomotion tree
  landFade: 0.22,       // how much of the landing clip we actually use

  // Foot-cycle length. The blend runs on a SHARED normalised phase so every
  // clip in the tree steps together; this is how many metres of ground one full
  // cycle covers, which is what keeps the feet from skating.
  walkStride: 1.55,
  runStride: 3.35,
};
