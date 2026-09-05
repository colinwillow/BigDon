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
import { CLIPS, CLIP_TUNING, DERIVED, MELEE_COMBO, MELEE_EXTRA, TUNING } from './clips.js';
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

    /** Clips that had baked-in travel taken out of them. Debug only. */
    this.deRooted = [];
    this._stripRootMotion();

    /** Clips whose duplicated last frame was trimmed. Debug only. */
    this.trimmed = [];
    this._trimLoopSeams();

    /** Names whose phase scrub runs backwards. See DERIVED in clips.js. */
    this.reversed = new Set();
    this._buildDerived();

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
    /** The overlay still draining out of the slot after endOneShot. */
    this._lastShot = null;
    /** The overlay being crossfaded out of the slot by a newer one. */
    this._prevShot = null;
    /** 0..1 handover between _prevShot and the current overlay. */
    this._shotMix = 1;
    this._oneShotWeight = 0;

    this.missing = [];
    /** Clips that carry no real motion. See _findFlatClips. */
    this.flat = [];
    this._warmup();
    this._findFlatClips();
  }

  /**
   * Flag clips that have names and durations but no actual keyframes.
   *
   * A re-export can drop the motion while keeping everything else: the clip
   * list looks perfect, the durations are right, the actions play and report
   * sensible weights — and the character stands in his bind pose the whole
   * time. It reads as "the animation system is broken" rather than "this file
   * has no animation in it", and every runtime check short of looking at the
   * screen passes.
   *
   * A track with two keys is a constant, so a clip that is nearly all
   * two-key tracks is holding a single pose. Real locomotion runs 20-50
   * animated tracks; anything with one or two has lost its data.
   */
  _findFlatClips() {
    for (const [name, clip] of this.clips) {
      if (clip.duration < 0.1) continue;          // t-pose stubs and the like
      const moving = clip.tracks.filter((t) => t.times.length > 2).length;
      if (moving <= 2 && clip.tracks.length > 20) this.flat.push(name);
    }
  }

  /**
   * Drop the duplicated final frame from cycles that have one.
   *
   * Every locomotion take in this pack ends on a byte-identical copy of its
   * first frame — which is how a cycle is normally authored, so that the last
   * key visually matches the first. Played back as a loop, though, that pose is
   * displayed TWICE in a row: once as the last frame and again as the next
   * cycle's first. At 24fps over a 14-frame sprint, that is a visible hitch
   * every single stride, and it reads as a limp rather than as an export
   * artefact.
   *
   * The fix is to end the cycle one frame BEFORE the duplicate. The tracks are
   * left alone; only the clip's duration moves, and since the whole blend tree
   * scrubs `time = phase * duration`, nothing ever lands on that frame again.
   *
   * Runs before _buildDerived so the reversed back-pedal inherits the trim.
   */
  /**
   * Take the baked travel out of the hips.
   *
   * The pack is advertised as in-place and the locomotion cycles genuinely are
   * — every walk and run measures a net hip displacement of 0.00. The ONE-SHOTS
   * are not: run_slide carries 255 units of Z (about 2.5m at this rig's scale),
   * kick_spin 67, jump_to_hang 37. Code owns movement here, so that travel is
   * not motion, it is a lie: the mesh slides forward of where the character
   * actually is and then snaps back the instant the clip stops driving him.
   * That snap is what reads as "he teleports back to where he was" after a
   * slide tackle, and no amount of procedural lunge fixes it because the two
   * are fighting rather than adding.
   *
   * The rule is per-clip and binary: a clip whose hips END somewhere else
   * horizontally has that channel PINNED to its first key; a clip that ends
   * where it began is not touched at all. That split falls exactly along
   * one-shots vs cycles in this pack, which is the split that matters — sway
   * and travel are the same channel and cannot be told apart within a clip, but
   * a cycle has no travel to remove and a one-shot's sway is subordinate to not
   * detaching from where the character actually is.
   *
   * Subtracting only the linear ramp was tried first, on the theory that it
   * would keep the sway. It does not work: run_slide's travel is not linear
   * (it eases out), and the slide plays barely half the clip, so the residual
   * measured 0.66m of drift mid-tackle — the same bug, three quarters smaller.
   *
   * Y is left alone: vertical hip travel is pose (the crouch dip, the climb) in
   * a way horizontal travel is not.
   *
   * Runs before _trimLoopSeams so the seam test sees the final values, and
   * before _buildDerived so the reversed back-pedal inherits the fix.
   */
  _stripRootMotion() {
    // Roughly a centimetre at this rig's scale — below it the "travel" is
    // export rounding, and there is nothing to take out.
    const MIN = 1.0;
    for (const [name, clip] of this.clips) {
      for (const t of clip.tracks) {
        if (!/(hips|root)\.position$/i.test(t.name)) continue;
        const n = t.times.length;
        if (n < 2) continue;
        const v = t.values;
        const dx = v[(n - 1) * 3] - v[0];
        const dz = v[(n - 1) * 3 + 2] - v[2];
        if (Math.hypot(dx, dz) < MIN) continue;
        for (let k = 1; k < n; k++) {
          v[k * 3] = v[0];
          v[k * 3 + 2] = v[2];
        }
        this.deRooted.push(`${name} (${Math.hypot(dx, dz).toFixed(1)})`);
      }
    }
  }

  _trimLoopSeams() {
    for (const [name, clip] of this.clips) {
      const step = this._frameStep(clip);
      if (!step || clip.duration <= step * 2) continue;
      if (!this._endsWhereItBegan(clip)) continue;
      clip.duration -= step;
      this.trimmed.push(name);
    }
  }

  /** Seconds between keys on the clip's densest track, or 0 if unclear. */
  _frameStep(clip) {
    let best = null;
    for (const t of clip.tracks) {
      if (!best || t.times.length > best.times.length) best = t;
    }
    if (!best || best.times.length < 3) return 0;
    const n = best.times.length;
    return (best.times[n - 1] - best.times[0]) / (n - 1);
  }

  /** Does every track's last key hold the same value as its first? */
  _endsWhereItBegan(clip) {
    // Picked off the measured spread in this pack, not guessed. Clips whose
    // last frame is a copy of the first land between 2e-6 and 3.2e-4 depending
    // on how the exporter rounded them; clips that genuinely end somewhere else
    // start at 3.0e-2 (hang_idle) and go up from there. Two clear orders of
    // magnitude between the groups, so anything under 1e-3 is a duplicate.
    //
    // For scale: 1e-3 on a quaternion component is about a tenth of a degree.
    // A tighter 1e-6 missed run_normal_forward and both crouch strafes, which
    // are duplicates in every way that matters.
    const EPS = 1e-3;
    let checked = 0;
    for (const t of clip.tracks) {
      const n = t.times.length;
      if (n < 3) continue;                       // constant tracks say nothing
      const size = t.values.length / n;
      for (let i = 0; i < size; i++) {
        const first = t.values[i];
        const last = t.values[(n - 1) * size + i];
        if (Math.abs(first - last) > EPS) return false;
      }
      checked++;
    }
    return checked > 0;
  }

  /**
   * Build the clips that are made from other clips — currently the back-pedal,
   * which this pack does not ship and which is just the forward gait reversed.
   *
   * A real cloned AnimationClip rather than a flag on the forward one, because
   * forward and back have to play SIMULTANEOUSLY at different weights while the
   * blend crossfades between them; one action cannot do both.
   */
  _buildDerived() {
    for (const [name, def] of Object.entries(DERIVED)) {
      const src = this.clips.get(def.from);
      if (!src) continue;
      const clip = src.clone();
      clip.name = name;
      this.clips.set(name, clip);
      if (def.reverse) this.reversed.add(name);
    }
  }

  /** Every clip the blend tree can reach, resolved up-front so a typo in
   *  clips.js surfaces at load rather than the first time you strafe. */
  _warmup() {
    const wanted = new Set();
    for (const [, v] of Object.entries(CLIPS)) {
      if (Array.isArray(v)) v.forEach((n) => wanted.add(n));
      else wanted.add(v);
    }
    // Sided melee clips are named at runtime, so resolve both sides now — a
    // typo in the combo list should surface at load, not on the third punch.
    for (const base of [...MELEE_COMBO, ...MELEE_EXTRA]) {
      wanted.add(base + '_left');
      wanted.add(base + '_right');
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

    this._want(CLIPS.idle, 1 - moving);

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
      // ADD, never set. The walk and run tiers can name the SAME clip — this
      // pack ships one strafe take per side, used at both speeds — and setting
      // would make the run tier silently erase the walk tier's contribution,
      // so a strafe would fade out entirely in the middle of the speed range.
      this._want(CLIPS['walk' + q.d], share * (1 - runBlend));
      this._want(CLIPS['run' + q.d], share * runBlend);
    }
  }

  /**
   * Call once at the moment he leaves the ground.
   *
   * There is no takeoff clip any more — see CLIPS.fall. The whole airborne arc
   * is one held pose, because a ~1s hang is not long enough to read a
   * takeoff/rise/fall sequence; blending three clips across it looked like a
   * stutter rather than a jump.
   */
  enterAir() {
    for (const n of [CLIPS.fall, CLIPS.dive]) {
      const a = this._action(n);
      if (a) a.setLoop(THREE.LoopRepeat, Infinity);
    }
  }

  /** Held crouch. One clip; the blend crossfade covers going down into it. */
  crouch() {
    this._want(CLIPS.crouch, 1);
  }

  /**
   * Airborne pose. One clip held, EXCEPT out of a long jump: `dive` is a
   * face-down tilt that reads as having thrown himself forward, wrong for an
   * ordinary hop and right for that. It crossfades back into the float, so the
   * caller just says how much of it it wants each frame.
   */
  air(dive = 0) {
    const d = clamp01(dive);
    this._want(CLIPS.dive, d);
    this._want(CLIPS.fall, 1 - d);
  }

  /**
   * Hanging from a ledge. `along` is the shimmy input in the edge's own frame,
   * -1..1, so the sided clips are chosen by which way he is actually sliding
   * rather than by which way the stick points on screen.
   */
  hang(along) {
    const mag = Math.min(Math.abs(along), 1);
    this._want(CLIPS.hangIdle, 1 - mag);
    if (along > 0) this._want(CLIPS.hangShimmyR, mag);
    else if (along < 0) this._want(CLIPS.hangShimmyL, mag);
  }

  /** Pressed against a wall. Same convention as hang(). */
  cover(along, side) {
    const mag = Math.min(Math.abs(along), 1);
    this._want(side === 'left' ? CLIPS.coverIdleL : CLIPS.coverIdleR, 1 - mag);
    if (mag > 0) this._want(side === 'left' ? CLIPS.coverSneakL : CLIPS.coverSneakR, mag);
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

    // A strike landing on top of a strike hands the SLOT over rather than
    // stacking: the outgoing clip keeps the slot's weight until the incoming
    // one has taken it. See update() for why the difference is visible.
    const outgoing = this.oneShot || this._lastShot;
    if (outgoing && outgoing.name !== name) {
      this._prevShot = outgoing;
      this._shotMix = 0;
    } else {
      this._prevShot = null;
      this._shotMix = 1;
    }
    this.oneShot = { name, action };
    this._lastShot = this.oneShot;
    return (clip.duration * (1 - start)) / Math.max(timeScale, 0.01);
  }

  /** Let the overlay fade back into the tree. */
  endOneShot() {
    // _lastShot stays: the slot is still worth _oneShotWeight while it drains,
    // and that weight has to keep going to the clip that earned it. Dropping it
    // into the tree instead let it decay on the tree's own half-life, so for a
    // few frames the weights summed to less than one — and the remainder in
    // three's mixer is the BIND POSE, which reads as him going briefly limp on
    // the way out of every strike.
    this.oneShot = null;
  }

  get busy() { return this.oneShot !== null; }

  // ── per-frame apply ───────────────────────────────────────────────────────

  update(dt) {
    // ── ONE BUDGET, NEVER MORE THAN ONE ─────────────────────────────────
    // three's mixer does not normalise: weights summing over 1 push the bones
    // past every clip that fed them, and weights summing under 1 give the
    // remainder to the BIND POSE. Both are visible, and a melee combo used to
    // do the first — the outgoing strike decayed on the TREE's half-life while
    // the incoming one rose on the overlay's, measured together at 1.54.
    //
    // So the overlay is a SLOT worth _oneShotWeight, the tree gets exactly what
    // is left, and when one strike replaces another the two share the slot
    // rather than each taking all of it.
    const wantOverlay = this.oneShot ? 1 : 0;
    const hl = this.oneShot ? TUNING.oneShotIn : TUNING.oneShotOut;
    this._oneShotWeight = damp(this._oneShotWeight, wantOverlay, hl, dt);
    this._shotMix = damp(this._shotMix, 1, TUNING.oneShotIn, dt);
    if (this._shotMix > 0.999) this._prevShot = null;
    if (this._oneShotWeight < 0.001 && !this.oneShot) this._lastShot = null;
    const treeScale = 1 - this._oneShotWeight;

    // The slot's occupant: the live overlay, or the one still draining out of
    // it after endOneShot.
    const held = this.oneShot || this._lastShot;

    for (const [name, action] of this.actions) {
      const isOverlay = (held && held.name === name)
        || (this._prevShot && this._prevShot.name === name);
      let w;
      if (held && held.name === name) {
        w = this._oneShotWeight * this._shotMix;
      } else if (this._prevShot && this._prevShot.name === name) {
        w = this._oneShotWeight * (1 - this._shotMix);
      } else {
        // Smoothed so a direction change crossfades rather than pops. The
        // overlay is exempt: a melee that eased in over 75ms would feel mushy.
        //
        // Note the target is the RAW one — treeScale is applied below, after
        // the damping, not folded into it. Damping toward an already-scaled
        // target makes the tree lag the overlay it is supposed to be making
        // room for: the overlay rises on a 0.05 half-life and the tree gets out
        // of the way on 0.075, so for the first few frames of every strike the
        // two summed to 1.36 and the poses fought. Scaling afterwards keeps the
        // tree a normalised blend of itself, worth exactly treeScale.
        w = damp(this.weights.get(name) || 0, this.target.get(name) || 0,
                 TUNING.blendHL, dt);
      }
      this.weights.set(name, w);
      action.setEffectiveWeight(isOverlay ? w : w * treeScale);

      // Scrub every locomotion clip to the shared phase. Air clips and overlays
      // (and the fading tail of a just-ended overlay) run on their own clock.
      if (!isOverlay && w > 0.001 && this._isLocomotion(name)) {
        const clip = this.clips.get(name);
        const off = (CLIP_TUNING[name] && CLIP_TUNING[name].phase) || 0;
        let p = (this.phase + off) % 1;
        if (p < 0) p += 1;
        // A derived back-pedal is the forward cycle scrubbed the other way.
        if (this.reversed.has(name)) p = 1 - p;
        action.time = p * clip.duration;
      }
    }

    // Clear the target map so a state that stops asking for a clip actually
    // lets it fall to zero, instead of it lingering at last frame's weight.
    this.target.clear();

    this.mixer.update(dt);
  }

  /** Accumulate a wanted weight for this frame. */
  _want(name, w) {
    if (!name) return;
    this.target.set(name, (this.target.get(name) || 0) + w);
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
