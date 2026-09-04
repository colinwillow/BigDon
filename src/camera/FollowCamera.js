// Third-person follow camera.
//
// Ported from Peggy, minus the water and the terrain sampling (this world is a
// flat plane). The lessons that made Robits' camera work, kept:
//
//  * Smoothing is dt-correct (half-lives, not per-frame lerp factors). Constant
//    factors judder the moment frame times vary, and the artefact reads as the
//    character stuttering, so it gets blamed on the movement code.
//  * Yaw is eased along the SHORTEST path and the lag is CAPPED. Without the
//    cap, a long turn builds a backlog that visibly unwinds when you stop — it
//    looks like the camera keeps turning after you let go.
//  * While the look stick is active, yaw tracks near 1:1. Follow-lag during
//    manual look feels like fighting the camera.
//  * The character sits ahead-of-centre in the direction of travel, so you see
//    where you're going instead of where you've been.

import * as THREE from '../../vendor/three/three.module.js';
import { clamp, clamp01, damp, dampAngle, wrapAngle, lerp } from '../core/math.js';

export const CAM = {
  distance: 6.3,
  height: 1.55,
  lookHeight: 1.15,

  // FIXED TILT. The player rotates the camera around him but never tilts it.
  // That's the convention for this kind of third-person action game, and the
  // real payoff is that it frees the right stick's vertical axis — and with it
  // the whole right thumb — for melee / shoot / jump instead of spending it on
  // a pitch axis nobody asks for.
  pitch: 0.16,           // ~9 degrees — the world ahead, not the ground

  yawRate: 3.4,          // radians/sec at full right-stick deflection
  swipeSens: 0.0075,     // radians per swiped pixel (touch / mouse)
  yawHL: 0.10,
  yawHLFree: 0.03,       // while the player is actively turning
  maxYawLag: 0.09,       // radians the camera may trail its target
  focusHL: 0.085,

  // Recentre, on demand. Deliberately NOT automatic: a camera that swings
  // itself behind you fights every deliberate angle you set, so instead the
  // player taps to snap it back when they want it.
  recentreHL: 0.11,

  // Twin-stick attract: while the right stick HOLDS a direction, the camera
  // keeps easing around behind it. Slower than a recentre on purpose — this is
  // "always adjusting", a follow, not a snap.
  attractHL: 0.30,

  lookAhead: 1.4,
  lookAheadHL: 0.35,

  // AIM mode: while the trigger is held the boom pulls in and rides lower.
  aimDistanceK: 0.80,
  aimHeightK: 0.60,
  aimBlendHL: 0.20,

  fovBase: 62,
  fovSpeedBoost: 9,      // widens with speed, which is most of the sense of pace
  fovHL: 0.28,

  shakeDecay: 2.6,
};

export class FollowCamera {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;
    this.targetYaw = 0;
    this.pitch = CAM.pitch;
    this.aimBlend = 0;
    this._aimHold = false;

    this.focus = new THREE.Vector3();
    this.distance = CAM.distance;
    this._distanceWanted = CAM.distance;
    this.trauma = 0;

    this._recentring = false;
    this._attractYaw = null;
    this._aimTurning = false;
    this._lookAhead = new THREE.Vector2();
    this._tmp = new THREE.Vector3();
  }

  /** Kick the camera without easing — for spawns and cuts. */
  snapTo(ch) {
    this.targetYaw = this.yaw = ch.facing + Math.PI;
    this.focus.set(ch.position.x, ch.position.y + CAM.lookHeight, ch.position.z);
    this.distance = this._distanceWanted = CAM.distance;
    this._recentring = false;
  }

  /**
   * Swing the camera back behind him. Bound to a tap on the MOVE stick, so a
   * player who is only running around never has to touch the right thumb.
   */
  recentre(ch) {
    this.targetYaw = ch.facing + Math.PI;
    this._recentring = true;
  }

  addTrauma(t) { this.trauma = clamp01(this.trauma + t); }

  /**
   * Ask the camera to work its way around behind `yaw` (a facing; the camera
   * sits at facing + PI). One-frame request — call it every frame the pull
   * should hold, and it simply lapses when you stop.
   */
  attract(yaw) { this._attractYaw = yaw + Math.PI; }

  /** Call every frame the trigger is held, to blend to the aim boom. */
  aimHold() { this._aimHold = true; }

  update(dt, ch, look) {
    this.aimBlend = damp(this.aimBlend, this._aimHold ? 1 : 0, CAM.aimBlendHL, dt);
    this._aimHold = false;

    // ── twin-stick attract ────────────────────────────────────────────────
    // Runs before manual input so a deliberate swipe mid-hold still wins the
    // frame (it moves targetYaw after we do).
    if (this._attractYaw != null) {
      this.targetYaw = dampAngle(this.targetYaw, this._attractYaw, CAM.attractHL, dt);
      this._attractYaw = null;
      this._recentring = false;
    }

    // ── manual rotation ───────────────────────────────────────────────────
    // Two inputs: a rate from held sticks (gamepad, Q/E) and swiped pixels
    // from touch/mouse. Horizontal only; look.y is ignored — see CAM.pitch.
    const dxPx = look.dxPx || 0;
    // Apply the rate WHENEVER there is one. This used to be gated behind
    // `> 0.05`, which stacked a second deadzone on top of the stick's own and
    // threw away exactly the gentle pushes the curve exists to make usable — a
    // quarter-deflection nudge produced a look value of 0.036 and moved the
    // camera not at all.
    if (look.x !== 0) this.targetYaw -= look.x * CAM.yawRate * dt;
    if (dxPx !== 0) this.targetYaw -= dxPx * CAM.swipeSens;
    // The FLAG is a separate question: it only picks the tracking half-life and
    // cancels a recentre, so it wants a threshold that ignores noise.
    const turning = Math.abs(look.x) > 0.02 || Math.abs(dxPx) > 0.5;
    if (turning) this._recentring = false;

    // ── ease yaw, with the lag cap ────────────────────────────────────────
    const hl = this._recentring ? CAM.recentreHL : (turning ? CAM.yawHLFree : CAM.yawHL);
    this.yaw = dampAngle(this.yaw, this.targetYaw, hl, dt);
    const lag = wrapAngle(this.targetYaw - this.yaw);
    if (this._recentring) {
      if (Math.abs(lag) < 0.02) { this.yaw = this.targetYaw; this._recentring = false; }
    } else {
      const maxLag = turning ? CAM.maxYawLag * 0.6 : CAM.maxYawLag;
      if (Math.abs(lag) > maxLag) this.yaw = this.targetYaw - Math.sign(lag) * maxLag;
    }

    // ── focus point, with look-ahead ──────────────────────────────────────
    const inv = 1 / Math.max(ch.T.runSpeed, 0.001);
    this._lookAhead.x = damp(this._lookAhead.x, ch.velocity.x * inv * CAM.lookAhead, CAM.lookAheadHL, dt);
    this._lookAhead.y = damp(this._lookAhead.y, ch.velocity.z * inv * CAM.lookAhead, CAM.lookAheadHL, dt);

    this.focus.x = damp(this.focus.x, ch.position.x + this._lookAhead.x, CAM.focusHL, dt);
    this.focus.y = damp(this.focus.y, ch.position.y + CAM.lookHeight, CAM.focusHL * 1.5, dt);
    this.focus.z = damp(this.focus.z, ch.position.z + this._lookAhead.y, CAM.focusHL, dt);

    // ── distance ──────────────────────────────────────────────────────────
    const want = CAM.distance * lerp(1, CAM.aimDistanceK, this.aimBlend);
    this._distanceWanted = damp(this._distanceWanted, want, 0.4, dt);
    this.distance = damp(this.distance, this._distanceWanted, 0.12, dt);

    // ── place it ──────────────────────────────────────────────────────────
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const dir = this._tmp.set(Math.sin(this.yaw) * cp, sp, Math.cos(this.yaw) * cp);

    this.camera.position.set(
      this.focus.x + dir.x * this.distance,
      this.focus.y + dir.y * this.distance
        + CAM.height * (1 - sp * 0.5) * lerp(1, CAM.aimHeightK, this.aimBlend),
      this.focus.z + dir.z * this.distance
    );

    // Never let the lens go under the floor.
    if (this.camera.position.y < 0.5) this.camera.position.y = 0.5;

    // ── shake ─────────────────────────────────────────────────────────────
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma;   // quadratic: small hits stay subtle
      this.camera.position.x += (Math.random() - 0.5) * s * 0.7;
      this.camera.position.y += (Math.random() - 0.5) * s * 0.7;
      this.camera.position.z += (Math.random() - 0.5) * s * 0.7;
      this.trauma = Math.max(0, this.trauma - CAM.shakeDecay * dt * this.trauma);
      if (this.trauma < 0.001) this.trauma = 0;
    }

    this.camera.lookAt(this.focus);

    // ── fov ───────────────────────────────────────────────────────────────
    const targetFov = CAM.fovBase + ch.speedRatio * CAM.fovSpeedBoost;
    this.camera.fov = damp(this.camera.fov, targetFov, CAM.fovHL, dt);
    this.camera.updateProjectionMatrix();
  }

  /** World-space direction the camera is facing, flattened. Used to map the
   *  sticks from screen space into world space. */
  forward(out) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }
  right(out) {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }
}
