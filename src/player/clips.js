// Which of the handyman GLB's 54 baked tracks drives which part of the game.
//
// Every clip is IN-PLACE — no track translates the character — so code owns
// movement and the clip owns the pose, and the two never fight.
//
// The exporter writes names as `Armature|<name>|Layer0`; loadCharacter strips
// that down to the bare name before anything here is looked up, so these are
// the names you see in Blender.

export const CLIPS = {
  // ── the locomotion blend tree ────────────────────────────────────────────
  idle: 'idle_1',

  walkF: 'walkg_forward',
  walkB: 'walk_back',            // DERIVED — see DERIVED below
  walkL: 'strafe_left',
  walkR: 'strafe_right',

  // Three forward gaits shipped (slow/normal/fast). The blend runs on a stride
  // phase rather than the clip's authored rate, so picking one is about the
  // POSE, not the timing: at a 9.6 m/s top speed the sprint pose is the right
  // one, and the walk covers everything below it.
  runF: 'run_fast_forward',
  runB: 'run_back',              // DERIVED
  runL: 'strafe_left',           // one strafe take per side, used at both tiers
  runR: 'strafe_right',

  // ── air ──────────────────────────────────────────────────────────────────
  // ONE clip for the whole airborne arc. The hang time is about a second, which
  // is not long enough to read a takeoff -> rise -> fall sequence: a three-part
  // blend just looks like it is stuttering between poses.
  //
  // `floating`, NOT `falling`: falling is a skydiver, face-down and spread,
  // which is a pose for a long drop. Floating is upright with the legs under
  // him, which is what a jump looks like.
  fall: 'floating',
  land: 'landing',
  doubleJump: 'jump_flip',

  // ── one-shots ────────────────────────────────────────────────────────────
  slide: 'run_slide',            // left-stick flick — the slide tackle

  // ── ledge / hang (mapped, state machine still to come) ───────────────────
  hangIdle: 'hang_idle',
  hangShimmyL: 'hang_shimmy_left',
  hangShimmyR: 'hang_shimmy_right',
  hangHopL: 'hang_hop_left',
  hangHopR: 'hang_hop_right',
  hangClimbUp: 'hang_to_climb_up',
  jumpToHang: 'jump_to_hang',
  standJumpToHang: 'stand_jump_to_hang',

  // ── cover / wall press (mapped, state machine still to come) ─────────────
  // stand_to_cover_* are NOT used: measured against the rig they are a ~140
  // degree turn-around, so entering cover played him spinning to face the wrong
  // way and then snapping into the idle. The facing eases in instead.
  coverInL: 'stand_to_cover_left',
  coverInR: 'stand_to_cover_right',
  coverIdleL: 'cover_idle_left',
  coverIdleR: 'cover_idle_right',
  coverSneakL: 'cover_sneak_left',
  coverSneakR: 'cover_sneak_right',
  coverOutL: 'cover_left_to_stand',
  coverOutR: 'cover_right_to_stand',

  // ── crouch (mapped, state machine still to come) ─────────────────────────
  // The held crouch pose. `crouch` is a 6.7s loop that is already crouched at
  // frame 0, so the blend crossfade covers going down into it — there is no
  // separate stand-to-crouch take and none is needed.
  crouch: 'crouch',
  crouchIdle: 'crouch_idle',
  crouchStrafeL: 'crouch_strafe_slow_left',
  crouchStrafeR: 'crouch_strafe_slow_right',
};

/**
 * Clips built at load time from other clips.
 *
 * There is no backward walk or run in this pack, and the blend tree needs one
 * or backing away plays a smeared average of the two strafes. Playing the
 * forward gait in reverse is the standard fix and reads convincingly as a
 * back-pedal — the legs drive the right way and the arms swing the right way,
 * because that is literally the forward cycle running backwards.
 *
 * These are real cloned AnimationClips rather than a flag on the forward one,
 * because forward and back have to be able to play SIMULTANEOUSLY at different
 * weights while the blend crossfades between them.
 */
export const DERIVED = {
  walk_back: { from: 'walkg_forward', reverse: true },
  run_back: { from: 'run_fast_forward', reverse: true },
};

/**
 * The melee combo, as unsided base names.
 *
 * Every strike in this pack ships mirrored, so the side is chosen at runtime
 * and ALTERNATES down the chain — jab left, hook right, elbow left. Picking a
 * side at random instead produces the same hand twice in a row often enough to
 * read as a hitch, and alternating is what a real combination looks like. The
 * starting side is random, so the same chain does not always open identically.
 *
 * Ordered short-to-committed: the jab is the fastest opener, the hurricane kick
 * is the finisher.
 */
export const MELEE_COMBO = [
  'punch_jab',
  'punch_hook',
  'punch_elbow',
  'kick_roundhouse',
  // The finisher was kick_spinning_hurricane, which is EMPTY: it carries two
  // animated tracks in both models, so the last hit of every combo held the
  // bind pose. `_findFlatClips` reports it at load. kick_spin is the same idea
  // and actually has data (23 tracks). Put the hurricane back if it is ever
  // re-exported with keyframes.
  'kick_spin',
];

/** Everything else that can be thrown, for variety and for later use. */
export const MELEE_EXTRA = ['kick', 'kick_spin', 'headbutt'];

/**
 * Per-clip tuning.
 *
 * `phase` shifts a locomotion clip's cycle so its footfalls line up with the
 * others in its tier — takes authored independently do not start on the same
 * foot, which reads as a hitch when the blend swings between them.
 *
 * `timeScale` sets the pace of a one-shot. `start` skips dead time at its head.
 */
export const CLIP_TUNING = {
  strafe_left: { phase: 0.5 },
  strafe_right: { phase: 0.0 },

  // The standing jump take is a whole jump-and-land at nearly 2s; only its
  // opening pop is used, so it runs fast and the air blend takes over.
  jump_still: { timeScale: 2.4 },
  landing: { timeScale: 1.7 },

  // The slide covers real ground, so it runs close to authored speed.
  run_slide: { timeScale: 1.5 },

  // The flip opens with a crouch-and-wind-up on the ground, which is wrong for
  // a DOUBLE jump — he is already airborne, so there is nothing to push off.
  // The clip is 24fps / 23 frames: the windup runs to about frame 7 and the
  // flip proper is frames 7-18, so this starts at the launch. (Cutting the 15
  // frames that windup *looks* like would take out the first half of the flip
  // itself — see scratch/flip-strip.png.)
  jump_flip: { start: 0.28, timeScale: 1.15 },

  // These takes are already short (0.79-1.21s). A light speed-up keeps them
  // punchy without turning the wind-up into a twitch.
  // Gentle. These were at 1.35-1.5, which combined with a fixed 0.34s recovery
  // meant a strike was faded out before even half of it had played — the swing
  // "started and then something else happened". Legibility beats speed here:
  // the strikes only feel fast if you can see them land.
  punch_jab: { timeScale: 1.25 },
  punch_hook: { timeScale: 1.2 },
  punch_elbow: { timeScale: 1.2 },
  kick_roundhouse: { timeScale: 1.15 },
  kick_spinning_hurricane: { timeScale: 1.1 },
  kick: { timeScale: 1.25 },
  kick_spin: { timeScale: 1.15 },
  headbutt: { timeScale: 1.25 },
};

/**
 * Movement + feel constants.
 *
 * ── WHERE THESE NUMBERS COME FROM ────────────────────────────────────────
 * Derived from Robits, which is the game this one is chasing. Robits normalises
 * its player to 18 world units, so 10 of its units is 1 metre here:
 *
 *   _RUN_MULT 1.55               ->  run is 1.55x walk
 *   _RUN_DEAD 0.45               ->  you break into a run at 45% deflection
 *   JUMP_BASE 240 / GRAV 320     ->  24 m/s up at 32 m/s^2 = a 9m apex
 *
 * Robits' player hovers, so its full speed would put a walking cycle somewhere
 * absurd. Taken directly: the 0.45 run threshold, the 32 m/s^2 gravity, and a
 * fast velocity ramp.
 */
export const TUNING = {
  // ── speeds, in metres/sec ────────────────────────────────────────────────
  walkSpeed: 3.1,
  runSpeed: 9.6,
  runAt: 0.45,          // Robits' _RUN_DEAD — commit to the run early

  accel: 72,            // reaches full run in about 0.13s
  decel: 88,
  airControl: 0.45,

  turnRate: 15.0,
  turnRateAim: 20.0,

  // ── body, for collision ──────────────────────────────────────────────────
  radius: 0.32,
  height: 1.75,
  stepHeight: 0.42,

  // ── jump ─────────────────────────────────────────────────────────────────
  jumpSpeed: 16.0,      // 4.0m apex at the gravity below, ~1.0s hang
  // The second jump is a little weaker, so a double is higher than a single but
  // not simply twice it — otherwise the first jump stops being a decision.
  doubleJumpSpeed: 13.5,
  gravity: 32.0,
  coyoteTime: 0.10,
  jumpBuffer: 0.14,

  // ── melee (right-stick flick) ────────────────────────────────────────────
  // A swing is a MOVE: none of these clips carry root motion, so the step into
  // the strike is procedural or it does not happen at all.
  // The strike's own turn. Faster than turnRate (a swing should snap round)
  // but eased, not assigned: a half turn takes about 0.13s, which lands inside
  // meleeLungeTime so he is pointing at the target before the hit does.
  meleeTurnRate: 24.0,
  meleeLungeSpeed: 11.0,
  meleeLungeTime: 0.18,
  // Control returns at this FRACTION of the strike's own length, so every clip
  // is nearly finished before the blend leaves it — a fixed number of seconds
  // cut the long kicks off in the middle while barely touching the jab. A
  // re-flick still interrupts immediately, so a combo is as fast as you flick.
  meleeRecoverFrac: 0.86,
  comboWindow: 0.75,
  // Right-stick flick while running at or above this does a SLIDE TACKLE
  // instead of a strike. Flicking the left stick while also steering with it is
  // awkward, so the slide lives on the free thumb.
  slideFromRunAt: 5.0,

  // ── ledge hang ───────────────────────────────────────────────────────────
  // The grab band is measured from the FEET, so it is directly comparable with
  // stepHeight and the jump apex — the numbers you actually tune against.
  hangReach: 0.42,        // how far in front of his own radius he can catch
  hangBandLow: 1.25,      // a ledge below this is a step-up or a vault, not a hang
  hangBandHigh: 2.55,     // above this his hands cannot reach it
  hangDrop: 1.86,         // feet sit this far under the ledge while hanging
  hangHeadroom: 1.6,      // space that must exist above a ledge to climb into
  shimmySpeed: 1.5,       // metres/sec sideways along the edge
  climbUpTime: 0.62,      // how long the pull-up takes before he stands on top
  hangGrace: 0.18,        // no re-grab for this long after dropping off

  // ── cover / wall press ───────────────────────────────────────────────────
  // Cover is MAGNETIC: cheap to enter, deliberately sticky to leave. Sliding
  // along a wall is the whole point of being on it, so the sideways deadzone is
  // wide and only a sustained hard pull directly away releases him.
  coverReach: 0.45,
  coverMinHeight: 1.1,    // a wall shorter than this is cover for nobody
  coverSneakSpeed: 2.4,
  coverEnterPush: 0.30,   // gentle push into a wall is enough to stick
  coverEnterSpeed: 6.5,   // ...and you can be moving at a fair clip doing it
  coverExitPull: 0.80,    // pulling away must be nearly full deflection
  coverExitHold: 0.22,    // ...and held this long, so a wobble never releases

  // ── crouch, and the long jump ────────────────────────────────────────────
  // Press the jump thumb and he crouches; release and he jumps. A tap is
  // therefore a very fast crouch-and-go, and a HOLD while running is a slide
  // whose momentum feeds a long jump — the Mario move.
  crouchFriction: 11.0,     // m/s^2 bled off while sliding; lower = longer slide
  crouchSteer: 3.0,         // rad/sec — he can still aim the slide, barely
  // The crouch windup every grounded jump goes through, tap included. Long
  // enough for the pose to read against blendHL (0.075) and short enough that
  // the jump still feels like it fired off the thumb.
  crouchMinTime: 0.11,
  // (the thumb thresholds that decide a press IS a crouch live with the stick,
  //  in Input.js — CROUCH_ARM_MS and CROUCH_MAX_PUSH.)
  // Release above this speed and the jump becomes a LONG jump: flatter, faster,
  // and much further. Below it, an ordinary jump.
  longJumpAt: 4.5,
  longJumpSpeed: 11.0,      // less up...
  longJumpBoost: 1.6,       // ...and considerably more along the ground

  // ── slide tackle (left-stick flick) ──────────────────────────────────────
  slideSpeed: 17.0,
  slideDuration: 0.55,
  slideCooldown: 0.30,

  // ── animation blending ───────────────────────────────────────────────────
  blendHL: 0.075,
  oneShotIn: 0.05,
  oneShotOut: 0.14,
  landFade: 0.20,

  // Metres of ground covered by one full foot cycle. The blend advances on
  // DISTANCE, not time, so these are what stop the feet skating.
  walkStride: 1.75,
  runStride: 4.6,
};
