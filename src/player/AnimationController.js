// Drives the character's 72 baked tracks from a handful of numbers the
// controller already knows: how fast he is going, which way relative to his
// facing, and whether he is on the ground.
//
// Three ideas do the work here.
//
// 1. WEIGHTS, NOT CROSSFADES. Every locomotion clip is playing all the time at
//    a weight the blender recomputes each frame. three's crossFadeTo is built
//    for discrete state changes and fights a continuous blend — interrupt one
//    mid-fade (which a thumb on a stick does constantly) and the weights it was
//    animating are left stranded part-way.
//
// 2. SHARED, DISTANCE-DRIVEN PHASE. Every clip in the tree is scrubbed to one
//    normalised cycle position, and that position advances with GROUND DISTANCE
//    TRAVELLED, not with wall-clock time. This is what stops the feet skating:
//    a stride is a fixed number of metres, so if he covers a metre the feet
//    have turned over exactly a metre's worth, at any speed. Free-running each
//    clip at its authored rate is what makes blended locomotion look like it is
//    on ice.
//
// 3. ONE-SHOT AS AN OVERLAY. Jump, melee and roll do not replace the tree, they
//    fade over the top of it and fade back out. So a melee mid-run keeps the
//    run underneath and blends back into whatever the stick is asking for by
//    the time the swing finishes.

import * as THREE from '../../vendor/three/three.module.js';
import { CLIPS, CLIP_TUNING, TUNING } from './clips.js';
import { clamp, clamp01, damp } from '../core/math.js';

/** The four cardinals of the blend tree, in screen-ish order. */
const DIRS = ['F', 'R', 'B', 'L'];
/**
 * Their angles in the character's local frame, measured as atan2(x, z) with
 * forward = local +Z.
 *
 * His RIGHT is local -Z-cross-up = local -X, so right is -PI/2 and left is
 * +PI/2. Derive this, never guess it: put a camera at (0,0,5) looking at the
 * origin and world +X lands on the right of the screen; a character facing +Z
 * is facing that camera, so his own right hand is at world -X — the mirror of
 * the screen. Getting it backwards swaps the strafe clips, and because a 180
 * degree error in the model's facing swaps them right back, the two bugs hide
 * each other and the character only looks wrong when he runs forwards.
 */
const DIR_ANGLE = { F: 0, R: -Math.PI / 2, B: Math.PI, L: Math.PI / 2 };

export class AnimationController {
  /**
   * @param {THREE.Object3D} root   the loaded GLB scene
   * @param {THREE.AnimationClip[]} clips  every track in the file
   */
  constructor(root, clips) {
    this.mixer = new THREE.AnimationMixer(root);
    this.clips = new Map();
    for (const c of clips) this.clips.set(c.name, c);

    /** name -> AnimationAction, created lazily and kept forever. */
    this.actions = new Map();
    /** name -> current smoothed weight. */
    this.weights = new Map();
    /** name -> weight the blender wants this frame. */
    this.target = new Map();

    /** Shared locomotion cycle position, 0..1. See note 2 above. */
    this.phase = 0;

    /** The active overlay, or null. */
    this.oneShot = null;
    this._oneShotWeight = 0;

    this.missing = [];
    this._warmup();
  }

  /** Every clip the blend tree can reach, resolved up-front so a typo in
   *  clips.js surfaces at load rather than the first time you strafe. */
  _warmup() {
    const wanted = new Set();
    for (const [, v] of Object.entries(CLIPS)) {
      if (Array.isArray(v)) v.forEach((n) => wanted.add(n));
      else wanted.add(v);
    }
    for (const name of wanted) {
      if (!this.clips.has(name)) { this.missing.push(name); continue; }
      this._action(name);
    }
  }

  _action(name) {
    let a = this.actions.get(name);
    if (a) return a;
    const clip = this.clips.get(name);
    if (!clip) return null;
    a = this.mixer.clipAction(clip);
    a.enabled = true;
    a.setEffectiveWeight(0);
    a.play();
    this.actions.set(name, a);
    this.weights.set(name, 0);
    return a;
  }

  /** Duration of a clip in seconds, or 1 if it is missing. */
  duration(name) {
    const c = this.clips.get(name);
    return c ? c.duration : 1;
  }

  // ── the blend tree ────────────────────────────────────────────────────────

  /**
   * Ask for a locomotion pose.
   *
   * @param {number} speed      ground speed in m/s
   * @param {number} localAngle direction of travel in the character's own
   *                            frame: 0 = forward, +PI/2 = his right.
   * @param {number} distance   metres travelled this frame — drives the phase
   */
  locomotion(speed, localAngle, distance) {
    const walk = TUNING.walkSpeed;
    const run = TUNING.runSpeed;

    // idle <-> moving. Ramps in over the first sliver of speed so a nudge of
    // the stick does not snap straight into a full walk cycle.
    const moving = clamp01(speed / (walk * 0.55));
    // walk <-> run inside the moving half.
    const runBlend = clamp01((speed - walk) / Math.max(run - walk, 0.001));

    this.target.set(CLIPS.idle, 1 - moving);

    // Pick the two cardinals either side of the travel direction and split the
    // weight between them by angle. Blending all four at once (bilinear on
    // x/z) muddies diagonals — two neighbours is what keeps a diagonal reading
    // as a real diagonal instead of a soft average of everything.
    const a = Math.atan2(Math.sin(localAngle), Math.cos(localAngle));
    const quad = [];
    for (const d of DIRS) {
      let delta = a - DIR_ANGLE[d];
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      if (Math.abs(delta) < Math.PI / 2 + 1e-4) {
        quad.push({ d, w: Math.cos(delta) });   // cos falls to 0 at 90 degrees
      }
    }
    let sum = 0;
    for (const q of quad) sum += q.w;
    if (sum <= 1e-5) { quad.length = 0; quad.push({ d: 'F', w: 1 }); sum = 1; }

    // Stride length follows the same walk/run blend, so the phase rate is
    // continuous across the tier change instead of jumping when he breaks into
    // a run.
    const stride = TUNING.walkStride + (TUNING.runStride - TUNING.walkStride) * runBlend;
    this.phase = (this.phase + distance / Math.max(stride, 0.01)) % 1;
    if (this.phase < 0) this.phase += 1;

    for (const q of quad) {
      const share = (q.w / sum) * moving;
      this.target.set(CLIPS['walk' + q.d], share * (1 - runBlend));
      this.target.set(CLIPS['run' + q.d], share * runBlend);
    }
  }

  /**
   * Call once at the moment he leaves the ground.
   *
   * ── THE TWITCH ────────────────────────────────────────────────────────────
   * jumping_up is 0.27s long, and every action in the tree is created with
   * three's default LoopRepeat. So the takeoff pop restarted three or four
   * times during a single ascent, which reads exactly as "it plays the first
   * few frames over and over". The clip has to run ONCE and then hold its last
   * pose while the blend hands over to the falling loop.
   */
  enterAir() {
    const up = this._action(CLIPS.jumpUp);
    if (up) {
      up.reset();
      up.setLoop(THREE.LoopOnce, 1);
      up.clampWhenFinished = true;   // hold the final pose, do not snap to frame 0
      up.timeScale = 1;
      up.play();
    }
    const fall = this._action(CLIPS.fall);
    if (fall) fall.setLoop(THREE.LoopRepeat, Infinity);
  }

  /**
   * Ask for an airborne pose. `vy` picks the point in the arc: the takeoff pop
   * carries the launch, then it crossfades into the falling loop.
   *
   * The handover is driven by the CLIP's own progress rather than by velocity.
   * Velocity alone made the blend depend on how high the jump was — after the
   * jump height went up, a long ascent sat on a clip that had finished playing
   * seconds earlier.
   */
  air(vy) {
    const up = this.actions.get(CLIPS.jumpUp);
    let pop = 0;
    if (up) {
      const dur = this.duration(CLIPS.jumpUp);
      // Fade out over the last third of the pop, so it hands over mid-clip
      // rather than landing on its clamped final frame and sitting there.
      pop = 1 - clamp01((up.time - dur * 0.62) / Math.max(dur * 0.38, 1e-3));
      // Once he is falling, the pop is over regardless of where the clip got to.
      if (vy < 0) pop = Math.min(pop, clamp01(1 + vy / 3));
    }
    this.target.set(CLIPS.jumpUp, pop);
    this.target.set(CLIPS.fall, 1 - pop);
  }

  // ── one-shots ─────────────────────────────────────────────────────────────

  /**
   * Fade a clip over the top of the tree. Returns its duration in seconds so
   * the caller can time the state it belongs to.
   *
   * Restarting a one-shot that is already the active overlay resets it to its
   * start — that is what makes a melee combo chain instead of the second swing
   * being swallowed by the first.
   */
  play(name, opts = {}) {
    const action = this._action(name);
    if (!action) return 0;
    const tune = CLIP_TUNING[name] || {};
    const timeScale = opts.timeScale ?? tune.timeScale ?? 1;
    const start = opts.start ?? tune.start ?? 0;
    const clip = this.clips.get(name);

    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.timeScale = timeScale;
    action.time = start * clip.duration;
    action.play();

    this.oneShot = { name, action };
    return (clip.duration * (1 - start)) / Math.max(timeScale, 0.01);
  }

  /** Let the overlay fade back into the tree. */
  endOneShot() {
    this.oneShot = null;
  }

  get busy() { return this.oneShot !== null; }

  // ── per-frame apply ───────────────────────────────────────────────────────

  update(dt) {
    // The overlay's weight is what the tree is scaled DOWN by, so the two
    // always sum to 1 and the character never goes limp between them.
    const wantOverlay = this.oneShot ? 1 : 0;
    const hl = this.oneShot ? TUNING.oneShotIn : TUNING.oneShotOut;
    this._oneShotWeight = damp(this._oneShotWeight, wantOverlay, hl, dt);
    const treeScale = 1 - this._oneShotWeight;

    for (const [name, action] of this.actions) {
      const isOverlay = this.oneShot && this.oneShot.name === name;
      let w;
      if (isOverlay) {
        w = this._oneShotWeight;
      } else {
        const t = (this.target.get(name) || 0) * treeScale;
        // Smoothed so a direction change crossfades rather than pops. The
        // overlay is exempt: a melee that eased in over 75ms would feel mushy.
        w = damp(this.weights.get(name) || 0, t, TUNING.blendHL, dt);
      }
      this.weights.set(name, w);
      action.setEffectiveWeight(w);

      // Scrub every locomotion clip to the shared phase. Air clips and overlays
      // (and the fading tail of a just-ended overlay) run on their own clock.
      if (!isOverlay && w > 0.001 && this._isLocomotion(name)) {
        const clip = this.clips.get(name);
        const off = (CLIP_TUNING[name] && CLIP_TUNING[name].phase) || 0;
        let p = (this.phase + off) % 1;
        if (p < 0) p += 1;
        action.time = p * clip.duration;
      }
    }

    // Clear the target map so a state that stops asking for a clip actually
    // lets it fall to zero, instead of it lingering at last frame's weight.
    this.target.clear();

    this.mixer.update(dt);
  }

  _isLocomotion(name) {
    if (name === CLIPS.idle) return false;   // idle free-runs; it has no stride
    for (const d of DIRS) {
      if (CLIPS['walk' + d] === name || CLIPS['run' + d] === name) return true;
    }
    return false;
  }

  /** Debug: the clips actually contributing this frame, strongest first. */
  activeList(limit = 4) {
    return [...this.weights.entries()]
      .filter(([, w]) => w > 0.02)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([n, w]) => `${n} ${w.toFixed(2)}`);
  }
}
