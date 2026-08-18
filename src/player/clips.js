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
 * `start` skips dead time at the head of a one-shot, and `timeScale` sets the
 * pace.
 *
 * `falling_to_roll` is the only roll in the pack, and despite the name it does
 * NOT open with a fall — frame 0 is already the tuck. Its shape is: tuck and
 * roll through to about 55%, then stand back up. It was previously started at
 * 62%, which skipped the whole roll and played only the getting-up, so the
 * dodge read as a stumble. Play it from zero, at double speed so a dodge is a
 * dodge and not a 1.8 second commitment.
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

  falling_to_roll:      { start: 0.0, timeScale: 2.0 },
  hard_landing:         { timeScale: 1.6 },
  jumping_up:           { timeScale: 1.0 },
};

/**
 * Movement + feel constants.
 *
 * ── WHERE THESE NUMBERS COME FROM ────────────────────────────────────────
 * Derived from Robits rather than invented, because that is the game this one
 * is chasing. Robits normalises its player to 18 world units tall, so 10 of its
 * units is 1 metre here, and its constants convert directly:
 *
 *   MOVE.topSpeed 269 (mobile)   ->  26.9 m/s        arcade-fast
 *   _RUN_MULT 1.55               ->  run is 1.55x walk
 *   _RUN_DEAD 0.45               ->  you break into a run at 45% deflection
 *   JUMP_BASE 240 / GRAV 320     ->  24 m/s up at 32 m/s^2 = a 9m apex
 *
 * Robits' player hovers, so its full 27-42 m/s would put Big Don's foot cycle
 * somewhere absurd. What IS taken directly: the 1.55 run ratio, the 0.45 run
 * threshold (the single biggest feel difference — you are running almost
 * immediately instead of having to shove the stick to 72%), the 32 m/s^2
 * gravity, and a fast velocity ramp. Speeds land at roughly double the old
 * values; the jump is a little under half Robits' height.
 */
export const TUNING = {
  // ── speeds, in metres/sec ────────────────────────────────────────────────
  walkSpeed: 3.1,
  runSpeed: 9.6,        // ~2x the old 5.0, and 1.55x a 6.2 m/s jog
  runAt: 0.45,          // Robits' _RUN_DEAD — commit to the run early

  // Robits eases velocity with a per-frame factor of ~0.20-0.28, which is a
  // ~0.08s time constant: near-instant by comparison to a gentle m/s^2 ramp.
  // That crispness is most of why its movement feels responsive rather than
  // floaty, so these are deliberately high.
  accel: 72,            // m/s^2 — reaches full run in about 0.13s
  decel: 88,
  airControl: 0.45,

  turnRate: 15.0,       // rad/sec when moving
  turnRateAim: 20.0,    // ...and when the aim stick owns the facing

  // ── jump ─────────────────────────────────────────────────────────────────
  // 16 m/s at 32 m/s^2 is a 4.0m apex and a 1.0s hang — over four times the old
  // height, and about 2.2 of his own heights. Robits' own jump is 5 heights
  // (9m for Big Don); raise jumpSpeed to 24 to match it exactly.
  jumpSpeed: 16.0,
  gravity: 32.0,
  coyoteTime: 0.10,     // still jumpable this long after walking off an edge
  jumpBuffer: 0.14,     // a jump pressed this soon before landing still fires

  // ── dash / roll (left-stick flick) ───────────────────────────────────────
  dashSpeed: 17.0,
  dashDuration: 0.50,
  dashCooldown: 0.30,

  // ── animation blending ───────────────────────────────────────────────────
  blendHL: 0.075,
  oneShotIn: 0.05,      // one-shots come in fast — a melee must feel immediate
  oneShotOut: 0.14,
  landFade: 0.20,

  // Foot-cycle length. The blend runs on a SHARED normalised phase so every
  // clip steps together; this is how many metres of ground one full cycle
  // covers, which is what keeps the feet from skating. Scaled up with the new
  // speeds — leaving them at the old values would spin the run cycle at nearly
  // three strides a second.
  walkStride: 1.75,
  runStride: 4.6,
};
