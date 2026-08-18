// Virtual thumbstick.
//
// Ported forward from Peggy (which ported it from Robits), where this got right
// after a lot of play-testing. The parts that are load-bearing and should not be
// "simplified" away:
//
//  * FLOATING mode. The stick's centre is wherever your thumb first lands
//    inside a big invisible zone, not a fixed circle you have to find. On a
//    phone you never look at your thumbs, so a fixed stick means constantly
//    re-finding it. Fixed mode is kept as an option because some people prefer
//    a stick that stays put, and it parks the knob where you last used it.
//
//  * FLICK PEAK LATCH. A fast flick can peak and return between two frames —
//    at 30fps that happens constantly — and a per-frame sample misses it
//    entirely, so the gesture "doesn't register". We latch the strongest
//    deflection seen since the consumer last read it, so a flick lands at any
//    frame rate.
//
//  * TAP vs PUSH. A short touch that never travels is a tap (jump), separate
//    from a push (move). Both live on the same thumb, which is how you fit
//    twin-stick + jump onto a screen with no buttons.
//
//  * Touch identifier tracking. Multi-touch is the whole point; without
//    matching identifiers the two sticks steal each other's fingers.

import { clamp01 } from '../core/math.js';

const TAP_MAX_MS = 220;      // longer than this is a hold, not a tap
const TAP_MAX_TRAVEL = 15;   // px — moved further than this, it was a push
const TAP_MAX_PUSH = 0.4;    // and it must never have deflected past this

// ── THE FOUR GESTURES ──────────────────────────────────────────────────────
// One thumb, four verbs, told apart by deflection over time. This is what lets
// the right stick carry camera + jump + melee + shoot without a single button.
//
//   TAP      down, barely moved, up fast              -> jump
//   HOLD     down, stays near centre, up after a beat -> (reserved)
//   FLICK    snapped out FAST and far                 -> melee / dash
//   PUSH     out and sustained                        -> steer camera / shoot
//
// TAP and HOLD are the same motion separated only by duration; FLICK and PUSH
// are the same motion separated only by speed. Both splits are reliable because
// a human doing one is not close to the threshold of the other.
const HOLD_MIN_MS = 220;     // past a tap, and it must have stayed near centre
// Generous on purpose. A thumb resting on glass for half a second wanders more
// than you'd think, and at 0.30 (19px of a 64px stick) ordinary wobble was
// disqualifying the hold. This same value is the camera's deadzone, so anywhere
// inside it is guaranteed camera-neutral.
const HOLD_MAX_PUSH = 0.38;
// A flick is defined by SPEED, not by "got far within a time window".
//
// The window version fired on ordinary camera drags: it started its clock the
// moment the thumb passed 30% deflection, and getting from 30% to 60% inside
// 230ms is something a deliberate drag does easily. Push and flick became the
// same gesture.
//
// Radial speed separates them cleanly. A real flick covers most of the stick in
// 60-90ms, so ~10-15 units/sec. A deliberate camera drag is 2-4 units/sec. The
// threshold sits in the empty middle.
const FLICK_MAG = 0.55;      // how far out it must get
const FLICK_SPEED = 6.0;     // deflection units per second — the arming test
const FLICK_RESET = 0.30;    // fall back inside this to re-arm the next flick
const FLICK_MUTE_MS = 260;   // camera ignores this stick briefly after a flick

// ── THE CAMERA IS SWIPE-BASED, AND WHY THAT MATTERS ────────────────────────
// The camera pans with thumb MOVEMENT (pixels of travel), not with held
// deflection. Once the pan is delta-based, a thumb that is out-and-STILL is
// doing nothing to the camera — so that posture is free to mean "aiming in this
// direction", which is what press-hold-release-to-fire needs. Rate-based
// panning could never allow it: held deflection WAS the camera.
//
// A fast pan and a flick are both fast, so the flick can't fire the instant it
// crosses the threshold — it becomes a CANDIDATE, and resolves on what happens
// next: released or snapped back quickly -> melee; still travelling after
// 200ms -> it was a pan all along. Camera deltas are buffered while a
// candidate is open (and for the first beat of every touch), then dropped on a
// flick or flushed to the camera on a pan — so a melee never whips the view
// and a pan loses nothing, it just starts a breath late.
const CAND_TIMEOUT_MS = 200; // candidate still travelling after this = a pan
const CAND_REBOUND = 0.12;   // deflection fallback from peak that fires the flick
const SWIPE_BUFFER_MS = 110; // deltas buffered at touch start, pending a verdict
const AIM_STILL_MS = 200;    // this long without above-slop movement
const CAM_SETTLE_MS = 90;    // out past the deadzone this long = a real drag

// ── SHOOT MODE (opts.shootStick) ───────────────────────────────────────────
// The Robits model: the right stick IS the gun, and its DIRECTION is the aim.
// Push it any way and the character turns there, the camera swings behind,
// and the weapon commits that way — hold to keep firing, steer while held,
// let it spring back to stop. Deflection is the whole verb, so a thumb
// resting at centre does nothing at all. Tap and flick keep theirs (jump,
// melee); the swipe-camera and the aim-hold gave their thumb-territory to
// the trigger. A fast snap becomes a flick candidate first, so a melee flick
// never fires a stray shot — the trigger engages only once the candidate
// window has passed (or immediately on a deliberate, non-snap push).
const SHOOT_ZONE = 0.40;     // deflection that pulls the trigger
const SHOOT_RELEASE = 0.26;  // spring back inside this to stop firing

export class Joystick {
  /**
   * @param {HTMLElement} zone  the touch region (a big invisible half-screen in floating mode)
   * @param {HTMLElement} knob  the visible thumb dot
   * @param {HTMLElement} ring  the visible base ring
   */
  constructor(zone, knob, ring, opts = {}) {
    this.zone = zone;
    this.knob = knob;
    this.ring = ring;

    this.x = 0;              // -1..1, screen-space right
    this.y = 0;              // -1..1, screen-space down
    this.mag = 0;            // 0..1 deflection
    this.angle = 0;          // radians, screen space

    this.floating = opts.floating !== false;
    this.radius = opts.radius ?? 64;      // px of travel for full deflection
    this.deadzone = opts.deadzone ?? 8;   // px before any output at all

    /** SHOOT MODE — see the constant block above. */
    this.shootMode = !!opts.shootStick;
    /** True while the trigger is pulled (deflected past SHOOT_ZONE). */
    this.shootActive = false;
    this._shotThisTouch = false;

    this.touchId = null;
    this.centreX = 0;
    this.centreY = 0;

    /** Gesture callbacks, set by the consumer. See THE FOUR GESTURES above. */
    this.onTap = null;          // ()      quick press, no travel
    this.onHoldRelease = null;  // ()      held near centre, then let go
    this.onFlick = null;        // (angle) snapped out fast — fires mid-motion
    this.onPress = null;
    this.onRelease = null;

    /** 0..1 while a hold is charging, for UI. Zero at every other moment. */
    this.holdCharge = 0;
    /**
     * True once a CLEAN touch (no flick, no early drag) has rested long enough
     * to become an aim-hold. From then on, deflection AIMS instead of turning
     * the camera, and release fires. Cleared on lift.
     */
    this.aimActive = false;
    this._flickedThisTouch = false;
    /** Last gesture recognised, for the on-screen readout: tap|hold|flick|drag */
    this.lastGesture = '';
    this._flicked = false;
    this._muteUntil = 0;
    this._lastFrac = 0;
    this._lastMoveT = 0;
    this._radialSpeed = 0;
    this._outSince = 0;
    this._cand = null;          // open flick candidate: { t, peak }
    this._pendingDx = 0;        // swipe px since last poll
    this._bufferDx = 0;         // swipe px held back pending flick-vs-pan
    this._stillSince = 0;
    this._lastPx = 0;

    this._tapStart = 0;
    this._tapTravelled = false;
    this._tapPeak = 0;
    this._peakMag = 0;
    this._peakAngle = 0;
    this._pressedCentre = false;

    /** Where the visible stick sits when nothing is touching it. */
    this.parkX = 0;
    this.parkY = 0;

    this._onStart = this._onStart.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onEnd = this._onEnd.bind(this);

    zone.addEventListener('touchstart', this._onStart, { passive: false });
    // move/end go on window so a thumb that slides outside the zone keeps steering
    window.addEventListener('touchmove', this._onMove, { passive: false });
    window.addEventListener('touchend', this._onEnd);
    window.addEventListener('touchcancel', this._onEnd);
  }

  get held() { return this.touchId !== null; }
  /**
   * True for a beat after a flick. The camera reads this and ignores the stick,
   * so a melee swipe doesn't also fling the view sideways — which is the whole
   * reason a flick and a camera drag can share one thumb.
   */
  get muted() { return performance.now() < this._muteUntil; }
  /**
   * True once the thumb has been held out past the deadzone long enough that
   * this is definitely a drag and not the wind-up of a flick.
   */
  get steadyOut() {
    return this._outSince !== 0 && performance.now() - this._outSince >= CAM_SETTLE_MS;
  }
  /** The deflection past which the camera responds — matches the hold zone. */
  static get camDeadzone() { return HOLD_MAX_PUSH; }
  /** True while the touch that began this hold started on the knob itself. */
  get centreHeld() { return this.touchId !== null && this._pressedCentre; }

  /**
   * Read and clear the strongest deflection since the last call.
   * Returns null if nothing crossed `threshold`.
   */
  consumeFlick(threshold = 0.85) {
    if (this._peakMag < threshold) return null;
    const out = { mag: this._peakMag, angle: this._peakAngle };
    this._peakMag = 0;
    return out;
  }

  _onStart(e) {
    if (this.touchId !== null) return;
    e.preventDefault();
    const t = e.changedTouches[0];

    if (this.knob) {
      const kr = this.knob.getBoundingClientRect();
      this._pressedCentre = Math.hypot(
        t.clientX - (kr.left + kr.width / 2),
        t.clientY - (kr.top + kr.height / 2)
      ) < 36;
    }

    if (this.floating) {
      // Centre lands under the thumb, wherever that is.
      this.centreX = t.clientX;
      this.centreY = t.clientY;
    } else {
      const r = this.zone.getBoundingClientRect();
      this.centreX = r.left + r.width / 2;
      this.centreY = r.top + r.height / 2;
      this.radius = r.width * 0.4;
    }
    this._showAt(this.centreX, this.centreY, 1);

    this.touchId = t.identifier;
    this._tapStart = performance.now();
    this._lastMoveT = this._tapStart;
    this._lastFrac = 0;
    this._radialSpeed = 0;
    this._outSince = 0;
    this.aimActive = false;
    this._flickedThisTouch = false;
    this._cand = null;
    this._pendingDx = 0;
    this._bufferDx = 0;
    this._stillSince = this._tapStart;
    this._lastPx = t.clientX;
    this._tapTravelled = false;
    this._tapPeak = 0;
    this._flicked = false;
    this.holdCharge = 0;
    this.shootActive = false;
    this._shotThisTouch = false;
    if (this.onPress) this.onPress();
    this._apply(t.clientX, t.clientY);
  }

  _onMove(e) {
    if (this.touchId === null) return;
    for (const t of e.changedTouches) {
      if (t.identifier !== this.touchId) continue;
      e.preventDefault();
      const travel = Math.hypot(t.clientX - this.centreX, t.clientY - this.centreY);
      if (travel > TAP_MAX_TRAVEL) this._tapTravelled = true;
      // swipe delta + stillness tracking, for the camera and the aim-hold.
      // Sub-slop deltas are dropped entirely: a resting thumb vibrates a pixel
      // or two per frame, and letting that pan meant a sloppy aim-hold drifted
      // the camera ~5 degrees before the aim engaged. Real pans move 4-10px a
      // frame and lose nothing to this.
      const pdx = t.clientX - this._lastPx;
      this._lastPx = t.clientX;
      // Stillness is judged by distance-per-EVENT, never px/second: browsers
      // coalesce touchmoves, so a moving thumb always produces above-slop
      // deltas no matter how janky the frame timing — whereas dividing by a
      // stretched dt made a real pan measure as "slow", the stillness clock
      // never reset, and the aim engaged in the middle of camera movement.
      if (Math.abs(pdx) >= 1.6) {
        this._pendingDx += pdx;
        this._stillSince = performance.now();
      }
      const frac = travel / this.radius;
      if (frac > this._tapPeak) this._tapPeak = frac;
      this._apply(t.clientX, t.clientY);
      this._gesture(frac);
      break;
    }
  }

  _onEnd(e) {
    if (this.touchId === null) return;
    for (const t of e.changedTouches) {
      if (t.identifier !== this.touchId) continue;
      const held = performance.now() - this._tapStart;
      const stillNearCentre = !this._tapTravelled && this._tapPeak < TAP_MAX_PUSH;
      const wasTap = stillNearCentre && held < TAP_MAX_MS;
      // A hold is the same motion as a tap, just sustained — and crucially it
      // must never have been pushed out, or it was a camera drag that happened
      // to start slowly.
      // Evaluated from the raw conditions at RELEASE, not from the aimActive
      // flag alone — the flag is set by poll(), poll rides rAF, and one long
      // frame across the rest window meant the hold was never marked and the
      // release fell through to "drag". Symmetric with the candidate timeout
      // below: anything that changes what a release MEANS gets re-derived at
      // the release itself.
      const now = performance.now();
      // In shoot mode the deflected-rest posture belongs to the trigger, so
      // the hold verb does not exist on this stick.
      const wasHold = !this.shootMode && !this._flickedThisTouch && (
        this.aimActive
        || (held >= HOLD_MIN_MS && now - this._stillSince >= AIM_STILL_MS
            && !(this._cand && now - this._cand.t <= CAND_TIMEOUT_MS))
      );
      // A candidate that ends in a release IS a flick — snapped out and let go
      // before the pan timeout. The timeout is re-checked HERE, not just in
      // poll(): poll rides requestAnimationFrame, and one janky frame is enough
      // for a stale candidate to survive to the release and fire a melee at
      // the end of a pan. Release-time checks cannot be starved.
      const wasSnapFlick = !this._flickedThisTouch && !wasTap && !wasHold
        && this._cand !== null
        && now - this._cand.t <= CAND_TIMEOUT_MS;

      this.touchId = null;
      this._pressedCentre = false;
      this.x = this.y = this.mag = 0;
      // Drop the flick latch on release, so a slow hold-then-lift (aiming)
      // can never be mistaken for a flick.
      this._peakMag = 0;

      if (this.floating) {
        // Park where it was last used. Snapping the knob back to the zone's
        // centre puts it halfway up the screen over the action buttons.
        this._showAt(this.centreX, this.centreY, 0.45);
      } else {
        this._resetKnob();
      }

      this.holdCharge = 0;
      this.aimActive = false;
      const wasShoot = this._shotThisTouch;
      this.shootActive = false;
      this._shotThisTouch = false;
      this.lastGesture = wasShoot ? 'shoot' : wasTap ? 'tap' : wasHold ? 'hold'
        : (this._flickedThisTouch || wasSnapFlick) ? 'flick' : 'drag';
      if (this.onRelease) this.onRelease();
      // A touch that fired the weapon spends its release on that — no verb.
      if (wasShoot) break;
      if (wasTap && this.onTap) this.onTap();
      else if (wasHold && this.onHoldRelease) this.onHoldRelease();
      else if (wasSnapFlick) this._fireFlick();
      break;
    }
  }

  _apply(px, py) {
    const dx = px - this.centreX;
    const dy = py - this.centreY;
    const dist = Math.hypot(dx, dy) || 0.0001;
    const ang = Math.atan2(dy, dx);
    const clamped = Math.min(dist, this.radius);

    if (this.knob) {
      this.knob.style.left = (this.centreX + Math.cos(ang) * clamped) + 'px';
      this.knob.style.top = (this.centreY + Math.sin(ang) * clamped) + 'px';
    }

    if (dist < this.deadzone) {
      this.x = this.y = this.mag = 0;
      return;
    }
    // Rescale past the deadzone so the first pixel of real travel maps to a
    // real (tiny) speed instead of stepping straight to ~15%.
    const n = clamp01((dist - this.deadzone) / (this.radius - this.deadzone));
    this.angle = ang;
    this.mag = n;
    this.x = Math.cos(ang) * n;
    this.y = Math.sin(ang) * n;

    if (n > this._peakMag) { this._peakMag = n; this._peakAngle = ang; }
  }

  /**
   * Runs on every move. Detects the flick, and tracks how long a low-deflection
   * hold has been charging.
   */
  _gesture(frac) {
    const now = performance.now();
    const dt = Math.max((now - this._lastMoveT) / 1000, 1 / 500);
    const prevFrac = this._lastFrac;
    const inst = (frac - this._lastFrac) / dt;
    // Smoothed, so one jittery sample between two touchmoves can't fire a melee.
    this._radialSpeed = this._radialSpeed * 0.5 + inst * 0.5;
    this._lastFrac = frac;
    this._lastMoveT = now;

    // Re-arm whenever the thumb comes back near the middle, so you can flick
    // repeatedly without lifting — which is how melee has to feel.
    if (frac < FLICK_RESET) this._flicked = false;

    // Track how long it has been continuously out past the camera's deadzone.
    if (frac >= HOLD_MAX_PUSH) { if (!this._outSince) this._outSince = now; }
    else this._outSince = 0;

    // ── flick candidate ───────────────────────────────────────────────────
    // Crossing the threshold fast ARMS a flick; it fires on a rebound (the
    // thumb snapping back toward centre — the apex of a real flick) and it is
    // cancelled if the thumb just keeps going, which is what a camera pan does.
    // Release-fire is handled in _onEnd.
    if (this._cand) {
      if (frac > this._cand.peak) this._cand.peak = frac;
      else if (frac < this._cand.peak - CAND_REBOUND) {
        this._fireFlick();
        return;
      }
    } else if (!this._flicked && !this._flickedThisTouch && !this.aimActive
        && prevFrac < FLICK_MAG && frac >= FLICK_MAG
        && this._radialSpeed >= FLICK_SPEED) {
      // Arms on the CROSSING only. Without the prevFrac guard, a pan whose
      // candidate had already timed out re-armed a fresh one every sample —
      // the thumb is still out and still fast — and the eventual lift fired a
      // melee at the end of every long camera pan.
      this._cand = { t: now, peak: frac };
    }
  }

  /**
   * Once per frame. Resolves candidate timeouts, decides what the buffered
   * swipe pixels become (camera pan or nothing), and runs the aim-hold clock.
   * Returns the swipe pixels the camera should consume this frame.
   */
  poll() {
    const now = performance.now();

    // ── shoot mode: the trigger replaces both the aim-hold and the swipe ──
    if (this.shootMode) {
      if (this._cand && now - this._cand.t > CAND_TIMEOUT_MS) this._cand = null;
      if (!this.held) {
        this.shootActive = false;
        return 0;
      }
      if (this.shootActive) {
        // Spring back toward centre (or a melee flick) lets go of the trigger.
        if (this.mag < SHOOT_RELEASE || this._flickedThisTouch) this.shootActive = false;
      } else if (!this._flickedThisTouch && !this.muted && !this._cand
          && this.mag >= SHOOT_ZONE) {
        // No open flick candidate: a deliberate push engages INSTANTLY; a
        // snapped push engages when its candidate window expires unresolved.
        this.shootActive = true;
        this._shotThisTouch = true;
        this.lastGesture = 'shoot';
      }
      return 0;   // this stick never pans the camera — the aim owns it
    }

    if (!this.held) {
      // flush anything a just-released pan left behind
      const out = this._bufferDx + this._pendingDx;
      this._bufferDx = 0;
      this._pendingDx = 0;
      this.holdCharge = 0;
      return this.muted ? 0 : out;
    }

    // candidate still travelling after the window: it was a pan
    if (this._cand && now - this._cand.t > CAND_TIMEOUT_MS) this._cand = null;

    // ── the aim-hold ──────────────────────────────────────────────────────
    // Held long enough, still long enough, and this touch has not flicked.
    // Deflection does NOT disqualify it — "press and hold in a direction,
    // release to launch that way" is the whole gesture. The camera can afford
    // this because a still thumb no longer pans.
    if (!this._flickedThisTouch) {
      const heldMs = now - this._tapStart;
      if (!this.aimActive && heldMs >= HOLD_MIN_MS && now - this._stillSince >= AIM_STILL_MS) {
        this.aimActive = true;
        this.lastGesture = 'hold';
      }
      this.holdCharge = this.aimActive ? clamp01((heldMs - HOLD_MIN_MS) / 380) : 0;
    } else {
      this.holdCharge = 0;
    }

    // ── swipe routing ─────────────────────────────────────────────────────
    if (this.aimActive || this.muted) {
      // aiming steers the action, not the view; post-flick motion is noise
      this._pendingDx = 0;
      this._bufferDx = 0;
      return 0;
    }
    const buffering = this._cand !== null || now - this._tapStart < SWIPE_BUFFER_MS;
    if (buffering) {
      this._bufferDx += this._pendingDx;
      this._pendingDx = 0;
      return 0;
    }
    const out = this._bufferDx + this._pendingDx;
    this._bufferDx = 0;
    this._pendingDx = 0;
    return out;
  }

  _fireFlick() {
    this._flicked = true;
    this._flickedThisTouch = true;
    this._cand = null;
    this._pendingDx = 0;        // a melee swipe contributes nothing to the camera
    this._bufferDx = 0;
    this._muteUntil = performance.now() + FLICK_MUTE_MS;
    this._outSince = 0;
    this.holdCharge = 0;
    this.lastGesture = 'flick';
    if (this.onFlick) this.onFlick(this.angle);
  }

  _showAt(x, y, opacity) {
    if (this.ring) {
      const d = this.radius * 2;
      this.ring.style.width = d + 'px';
      this.ring.style.height = d + 'px';
      this.ring.style.left = x + 'px';
      this.ring.style.top = y + 'px';
      this.ring.style.opacity = String(opacity);
    }
    if (this.knob) {
      this.knob.style.left = x + 'px';
      this.knob.style.top = y + 'px';
      this.knob.style.opacity = String(Math.max(opacity, 0.5));
    }
  }

  _resetKnob() {
    if (this.knob) {
      this.knob.style.left = this.centreX + 'px';
      this.knob.style.top = this.centreY + 'px';
    }
    if (this.ring) this.ring.style.opacity = '0.35';
  }

  /** Put the visible stick somewhere sensible before it's ever been touched. */
  park(x, y) {
    this.parkX = this.centreX = x;
    this.parkY = this.centreY = y;
    if (!this.held) this._showAt(x, y, 0.32);
  }

  dispose() {
    this.zone.removeEventListener('touchstart', this._onStart);
    window.removeEventListener('touchmove', this._onMove);
    window.removeEventListener('touchend', this._onEnd);
    window.removeEventListener('touchcancel', this._onEnd);
  }
}
