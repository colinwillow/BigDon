// The player character: movement, facing, and the state machine that decides
// which animation the AnimationController is asked for.
//
// Movement is kinematic — no physics engine. The world is a flat plane for now,
// so "ground" is y === 0 and collision is a clamp. Everything below is written
// so that swapping in a real ground query later touches one method (`groundAt`).
//
// ── THE TWO FACING MODES, WHICH IS THE WHOLE TWIN-STICK DESIGN ─────────────
//
// FREE: nothing on the right stick. He faces where he is going, and the
// locomotion tree only ever needs its forward clips. This is running around.
//
// AIM: the right stick is deflected (shooting) — he faces where the RIGHT stick
// points, independently of where the LEFT stick is pushing him. Now travel
// direction and facing come apart, and the 8-way strafe blend earns its keep:
// backing away while facing a target plays the back-pedal, sidestepping plays
// the strafes. This is the difference between a twin-stick game and a game with
// two sticks.

import * as THREE from '../../vendor/three/three.module.js';
import { AnimationController } from './AnimationController.js';
import { CLIPS, MELEE_COMBO, TUNING } from './clips.js';
import { clamp, clamp01, damp, smoothstep, wrapAngle, angleDelta, moveTowardAngle } from '../core/math.js';

const UP = new THREE.Vector3(0, 1, 0);

export class Character {
  /**
   * @param {THREE.Object3D} model  normalised GLB scene (feet at y=0, 1.8m tall)
   * @param {THREE.AnimationClip[]} clips
   */
  constructor(model, clips, collider = null) {
    this.model = model;
    /**
     * World collision. Optional: with no collider the world is a flat plane at
     * y=0, which is what the headless controller tests run against.
     */
    this.collider = collider;
    this.anim = new AnimationController(model, clips);
    this.T = TUNING;

    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    /** Horizontal speed, m/s. */
    this.speed = 0;
    /** Which way he points, radians. Forward is (sin, cos). */
    this.facing = 0;
    /** Where the aim stick is pointing, when it is. */
    this.aimYaw = 0;
    this.aiming = false;

    this.grounded = true;
    this.state = 'ground';       // ground | air | slide | melee | land
    this._stateT = 0;
    this._oneShotEnds = 0;

    this._coyote = 0;
    this._jumpBuffered = -1;
    this._slideCooldown = 0;
    this._slideDir = new THREE.Vector3();
    this._meleeDir = new THREE.Vector3();
    this._comboIndex = 0;
    this._comboT = 0;
    /** Which hand/foot the NEXT strike uses. Alternates down the chain. */
    this._meleeSide = Math.random() < 0.5 ? 'left' : 'right';

    /** Ledge currently held, or null. Shape comes from Collider.findLedge. */
    this.ledge = null;
    this._hangT = 0;              // position along the edge
    this._noGrabUntil = 0;
    this._climbT = 0;
    /** Wall currently pressed against, or null. */
    this.cover = null;

    /**
     * Corrects a model whose bind pose does not face +Z. Measured once at load
     * (see normaliseModel) rather than hard-coded, so re-exporting the GLB from
     * a different tool does not silently mirror the character.
     */
    this.modelYawOffset = model.userData.yawOffset || 0;

    this._moveWorld = new THREE.Vector3();
  }

  get speedRatio() { return clamp01(this.speed / this.T.runSpeed); }

  /**
   * Highest ground under him, searched across the span he fell through this
   * frame rather than only at his final position — he falls at 32 m/s^2 from a
   * 4m apex, so a long frame covers most of a metre and a final-position-only
   * test drops him straight through a platform.
   */
  groundAt(x, z, yFrom, yTo) {
    if (!this.collider) return 0;
    return this.collider.groundAt(x, z, this.T.radius, yFrom, yTo);
  }

  // ── the verbs, called from Input ─────────────────────────────────────────

  /** Right-stick tap. Buffered, so pressing just before landing still fires. */
  requestJump() {
    this._jumpBuffered = this.T.jumpBuffer;
  }

  /** Left-stick flick: the slide tackle, in the flicked direction. */
  requestSlide(worldAngle) {
    if (this._slideCooldown > 0) return false;
    if (this.state === 'slide') return false;
    this._slideCooldown = this.T.slideCooldown + this.T.slideDuration;
    this._slideDir.set(Math.sin(worldAngle), 0, Math.cos(worldAngle));
    // The slide commits its facing to the slide direction — there is one take,
    // and it slides straight ahead.
    this.facing = worldAngle;
    this._enter('slide');
    this._oneShotEnds = this.anim.play(CLIPS.slide);
    return true;
  }

  /**
   * Right-stick flick: melee.
   *
   * Chains: re-flicking inside `comboWindow` advances to the next swing and
   * INTERRUPTS the current one, so a combo is as fast as you can flick rather
   * than being paced by the clips. Letting the window lapse resets to the
   * opener.
   */
  requestMelee(worldAngle) {
    if (this.state === 'slide') return false;
    // The window is checked against the combo timer, not against being mid-
    // swing: a chain has to survive the swing ending, or the second hit only
    // lands if you flick during the first one's animation.
    if (this._comboT <= 0) {
      this._comboIndex = 0;
      // A fresh chain opens on a random side, so the same combo does not always
      // start with the same hand.
      this._meleeSide = Math.random() < 0.5 ? 'left' : 'right';

    /** Ledge currently held, or null. Shape comes from Collider.findLedge. */
    this.ledge = null;
    this._hangT = 0;              // position along the edge
    this._noGrabUntil = 0;
    this._climbT = 0;
    /** Wall currently pressed against, or null. */
    this.cover = null;
    } else {
      this._comboIndex = (this._comboIndex + 1) % MELEE_COMBO.length;
      // ALTERNATE, do not re-roll. Random sides throw the same hand twice in a
      // row often enough to read as a hitch; alternating is what a real
      // combination looks like.
      this._meleeSide = this._meleeSide === 'left' ? 'right' : 'left';
    }
    this._comboT = this.T.comboWindow;
    if (worldAngle != null) this.facing = worldAngle;
    // Lunge along the FACING, which the line above has just set to the flick
    // direction — so he steps into wherever you swung.
    this._meleeDir.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    this._enter('melee');
    this._oneShotEnds = this.anim.play(this.currentMeleeClip);
    return true;
  }

  /** The sided clip name the current combo step resolves to. */
  get currentMeleeClip() {
    return MELEE_COMBO[this._comboIndex] + '_' + this._meleeSide;
  }

  /**
   * Try to catch a ledge in front of him. Called every airborne frame; cheap
   * enough to poll and much more forgiving than requiring a button.
   */
  _tryGrabLedge(now) {
    if (!this.collider || now < this._noGrabUntil) return false;
    if (this.velocity.y > 1.0) return false;   // only on the way up's tail or falling
    const l = this.collider.findLedge(
      this.position.x, this.position.z, this.position.y,
      Math.sin(this.facing), Math.cos(this.facing), this.T.radius,
      {
        reach: this.T.hangReach,
        bandLow: this.T.hangBandLow,
        bandHigh: this.T.hangBandHigh,
        headroom: this.T.hangHeadroom,
      }
    );
    if (!l) return false;
    this.ledge = l;
    // Face INTO the wall: the outward normal points at him, so his facing is
    // its negation.
    this.facing = Math.atan2(-l.nx, -l.nz);
    // The edge runs along whichever axis the wall does not face.
    this._hangT = l.nz !== 0 ? this.position.x : this.position.z;
    this._snapToLedge();
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.anim.endOneShot();
    this._enter('hang');
    return true;
  }

  /** Put him at the hang position for the current edge offset. */
  _snapToLedge() {
    const l = this.ledge;
    // Leave a body's width at each end so he cannot hang off thin air past the
    // corner of the box.
    const pad = this.T.radius;
    this._hangT = clamp(this._hangT, l.minT + pad, l.maxT - pad);
    if (l.nz !== 0) { this.position.x = this._hangT; this.position.z = l.z; }
    else { this.position.x = l.x; this.position.z = this._hangT; }
    this.position.y = l.top - this.T.hangDrop;
  }

  /** Let go and fall. */
  releaseLedge() {
    if (!this.ledge) return;
    this.ledge = null;
    this._noGrabUntil = this._now + this.T.hangGrace;
    this.anim.endOneShot();
    this.anim.enterAir();
    this._enter('air');
  }

  /** Pull up onto the ledge he is holding. */
  climbLedge() {
    if (!this.ledge || this.state === 'climb') return false;
    this._enter('climb');
    this._climbT = 0;
    this._oneShotEnds = this.anim.play(CLIPS.hangClimbUp);
    return true;
  }

  /** Press against a wall in front of him. */
  _tryCover() {
    if (!this.collider || !this.grounded) return false;
    const w = this.collider.findWall(
      this.position.x, this.position.z, this.position.y,
      Math.sin(this.facing), Math.cos(this.facing), this.T.radius,
      { reach: this.T.coverReach, minHeight: this.T.coverMinHeight }
    );
    if (!w) return false;
    this.cover = w;
    this.facing = Math.atan2(-w.nx, -w.nz);
    this._hangT = w.nz !== 0 ? this.position.x : this.position.z;
    this._enter('cover');
    this._oneShotEnds = this.anim.play(
      (this._coverSideHeld = 'right') === 'left' ? CLIPS.coverInL : CLIPS.coverInR
    );
    return true;
  }

  /**
   * Resolve stick input into movement ALONG a surface.
   *
   * The tangent is simply the axis the surface does NOT face, and the input is
   * its plain component — no multiplying by the normal's sign. Doing that (the
   * first version of this) inverts movement on walls facing one way, so
   * shimmying and cover-sneaking went the opposite direction depending on which
   * face of a block you were on.
   *
   * The sided CLIP is a separate question, answered by which of his own
   * shoulders he is travelling toward, so it stays correct on every face.
   */
  _alongSurface(n) {
    const tx = n.nz !== 0 ? 1 : 0;
    const tz = n.nz !== 0 ? 0 : 1;
    const input = this._moveWorld.x * tx + this._moveWorld.z * tz;
    // His right, given forward = (sin f, cos f), is (-cos f, sin f).
    const rx = -Math.cos(this.facing);
    const rz = Math.sin(this.facing);
    const side = (tx * rx + tz * rz) * input >= 0 ? 'right' : 'left';
    return { tx, tz, input, side };
  }

  leaveCover() {
    if (!this.cover) return;
    this.cover = null;
    this.anim.endOneShot();
    this._enter('ground');
  }

  _enter(state) {
    this.state = state;
    this._stateT = 0;
  }

  // ── per-frame ────────────────────────────────────────────────────────────

  /**
   * @param {number} dt
   * @param {{moveX:number, moveZ:number, moveMag:number,
   *          aiming:boolean, aimYaw:number}} input  already in WORLD space
   */
  update(dt, input) {
    this._now = (this._now || 0) + dt;
    this._stateT += dt;
    this._slideCooldown = Math.max(0, this._slideCooldown - dt);
    this._comboT = Math.max(0, this._comboT - dt);
    if (this._jumpBuffered >= 0) this._jumpBuffered -= dt;

    this.aiming = input.aiming;
    if (input.aiming) this.aimYaw = input.aimYaw;

    const wasGrounded = this.grounded;

    // ── horizontal intent ────────────────────────────────────────────────
    this._moveWorld.set(input.moveX, 0, input.moveZ);
    const intent = Math.min(this._moveWorld.length(), 1);
    if (intent > 1e-4) this._moveWorld.normalize();

    // Stick deflection picks the gait: eased out is a walk, pushed past runAt
    // commits to a run. Mapping deflection straight to speed instead would mean
    // every intermediate deflection is a speed the animation has no clip for.
    let wantSpeed = 0;
    if (intent > 0.02) {
      wantSpeed = intent < this.T.runAt
        ? this.T.walkSpeed * (intent / this.T.runAt)
        : this.T.walkSpeed + (this.T.runSpeed - this.T.walkSpeed)
            * ((intent - this.T.runAt) / (1 - this.T.runAt));
    }

    // ── state machine ────────────────────────────────────────────────────
    switch (this.state) {
      case 'slide': {
        // The slide owns the velocity outright — stick input during it is
        // ignored, which is what makes it read as a committed move.
        const t = clamp01(this._stateT / this.T.slideDuration);
        const curve = 1 - t * t;            // fast out, easing to nothing
        this.velocity.x = this._slideDir.x * this.T.slideSpeed * curve;
        this.velocity.z = this._slideDir.z * this.T.slideSpeed * curve;
        if (this._stateT >= Math.min(this.T.slideDuration, this._oneShotEnds)) {
          this.anim.endOneShot();
          this._enter(this.grounded ? 'ground' : 'air');
        }
        break;
      }
      case 'melee': {
        // A short forward lunge, then a hard stop. None of the melee clips
        // carry root motion, so without this he swings on the spot and the
        // player has to walk the last half metre in themselves.
        const lt = clamp01(this._stateT / this.T.meleeLungeTime);
        const punch = 1 - lt * lt;          // hardest on frame one, gone by the end
        this.velocity.x = this._meleeDir.x * this.T.meleeLungeSpeed * punch;
        this.velocity.z = this._meleeDir.z * this.T.meleeLungeSpeed * punch;
        // Hand control back at meleeRecover even though the clip runs longer —
        // the animation keeps playing into its fade, but he stops being a
        // statue. Waiting for the full clip is what made one swing feel like a
        // commitment.
        if (this._stateT >= Math.min(this._oneShotEnds, this.T.meleeRecover)) {
          this.anim.endOneShot();
          this._enter(this.grounded ? 'ground' : 'air');
        }
        break;
      }
      case 'land': {
        // A brief plant on touchdown. Movement is allowed but damped, so a
        // landing does not cost control — it just costs a beat of speed.
        this._accelerate(dt, this._moveWorld, wantSpeed * 0.6, 1);
        if (this._stateT >= this.T.landFade) {
          this.anim.endOneShot();
          this._enter('ground');
        }
        break;
      }
      case 'hang': {
        // Suspended: no gravity, no ground, position owned by the edge.
        this.velocity.set(0, 0, 0);
        const l = this.ledge;
        const a = this._alongSurface(l);
        if (Math.abs(a.input) > 0.15) {
          this._hangT += a.input * this.T.shimmySpeed * dt;
        }
        this._snapToLedge();
        // Pushing INTO the wall climbs; pulling away drops. The wall's outward
        // normal points at him, so pushing in is movement against it.
        const into = -(this._moveWorld.x * l.nx + this._moveWorld.z * l.nz);
        if (into > 0.55) this.climbLedge();
        else if (into < -0.55) this.releaseLedge();
        break;
      }
      case 'climb': {
        // Carry him from the hang position up onto the top over the clip, then
        // hand him back to the ground state standing on it. Driving this
        // procedurally rather than trusting the clip is deliberate: the clip is
        // in-place, so on its own he would pull up and stay exactly where he was.
        const l = this.ledge;
        this._climbT = clamp01(this._climbT + dt / this.T.climbUpTime);
        const e = smoothstep(this._climbT);
        this.velocity.set(0, 0, 0);
        const startY = l.top - this.T.hangDrop;
        this.position.y = startY + (l.top - startY) * e;
        // ...and inward across the second half, so he ends standing ON the top
        // rather than balanced on its lip.
        const inward = Math.max(0, e - 0.5) * 2;
        const dist = this.T.radius * 1.9 * inward;
        if (l.nx) { this.position.x = l.x - l.nx * dist; }
        else { this.position.z = l.z - l.nz * dist; }
        if (this._climbT >= 1) {
          this.ledge = null;
          this.position.y = l.top;
          this.grounded = true;
          this.anim.endOneShot();
          this._enter('ground');
        }
        break;
      }
      case 'cover': {
        // Flattened against the wall: he moves only along it.
        const w = this.cover;
        const a = this._alongSurface(w);
        const pad = this.T.radius;
        if (Math.abs(a.input) > 0.15) {
          this._hangT = clamp(
            this._hangT + a.input * this.T.coverSneakSpeed * dt,
            w.minT + pad, w.maxT - pad
          );
        }
        if (w.nx) { this.position.x = w.x; this.position.z = this._hangT; }
        else { this.position.x = this._hangT; this.position.z = w.z; }
        this.velocity.set(0, 0, 0);
        const out = this._moveWorld.x * w.nx + this._moveWorld.z * w.nz;
        if (out > 0.55) this.leaveCover();
        break;
      }
      case 'air':
        this._accelerate(dt, this._moveWorld, wantSpeed, this.T.airControl);
        // Catching a ledge is polled, not asked for: requiring a button here
        // means missing the grab is the player's fault rather than the level's.
        this._tryGrabLedge(this._now);
        break;
      default:
        this._accelerate(dt, this._moveWorld, wantSpeed, 1);
        break;
    }

    // ── jump ─────────────────────────────────────────────────────────────
    const canJump = (this.grounded || this._coyote > 0)
      && this.state !== 'slide' && this.state !== 'melee'
      && this.state !== 'hang' && this.state !== 'climb' && this.state !== 'cover';
    if (this._jumpBuffered >= 0 && canJump) {
      this.velocity.y = this.T.jumpSpeed;
      this.grounded = false;
      this._coyote = 0;
      this._jumpBuffered = -1;
      this.anim.endOneShot();
      this.anim.enterAir();
      this._enter('air');
    }

    // ── suspended states own their own position entirely ─────────────────
    // Gravity, the world sweep and the ground query all skip these; a hang that
    // is still subject to gravity slides down the wall a few centimetres a
    // frame, which reads as the grab not holding.
    const suspended = this.state === 'hang' || this.state === 'climb' || this.state === 'cover';
    if (suspended) {
      this.speed = 0;
      this._updateFacing(dt, 0);
      this._drive(dt);
      this.model.position.copy(this.position);
      this.model.rotation.y = this.facing + this.modelYawOffset;
      return;
    }

    // ── gravity + ground ─────────────────────────────────────────────────
    if (!this.grounded) this.velocity.y -= this.T.gravity * dt;

    // ── horizontal, then resolve against the world ───────────────────────
    // Split from the vertical move on purpose: resolving both at once makes a
    // wall you are running into also cancel your fall, which reads as sticking
    // to it mid-air.
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    if (this.collider) {
      const hit = this.collider.resolve(
        this.position, this.T.radius, this.T.height, this.T.stepHeight
      );
      // Kill the velocity component that went into the wall. Without this he
      // keeps accelerating into it and squirts along the surface the instant it
      // ends, which looks like the collision failed.
      if (hit.nx) this.velocity.x = 0;
      if (hit.nz) this.velocity.z = 0;
      this.wallContact = hit.hitWall;
      if (hit.stepped) this.grounded = true;
    }

    // ── vertical ─────────────────────────────────────────────────────────
    const yBefore = this.position.y;
    this.position.y += this.velocity.y * dt;

    if (this.collider && this.velocity.y > 0) {
      const ceil = this.collider.ceilingAt(
        this.position.x, this.position.z, this.T.radius, yBefore + this.T.height
      );
      if (this.position.y + this.T.height > ceil) {
        this.position.y = ceil - this.T.height;
        this.velocity.y = 0;   // bonk
      }
    }

    // Only look for ground while falling or already resting on it; searching
    // upward on the way up would snap him onto the platform he is rising past.
    const groundY = this.velocity.y > 0
      ? -Infinity
      : this.groundAt(this.position.x, this.position.z, yBefore, this.position.y);
    if (this.position.y <= groundY) {
      this.position.y = groundY;
      if (!wasGrounded && this.velocity.y < -1) {
        // Landed. A hard landing gets the plant; a small hop just carries on,
        // because interrupting a run with a landing animation every time he
        // clears a kerb is worse than no landing animation at all.
        if (this.velocity.y < -7 && this.state !== 'slide') {
          this._enter('land');
          this._oneShotEnds = this.anim.play(CLIPS.land);
        } else if (this.state === 'air') {
          this._enter('ground');
        }
      }
      this.velocity.y = 0;
      this.grounded = true;
      this._coyote = this.T.coyoteTime;
    } else {
      this.grounded = false;
      this._coyote = Math.max(0, this._coyote - dt);
      if (this.state === 'ground') { this.anim.enterAir(); this._enter('air'); }
    }

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);

    // ── facing ───────────────────────────────────────────────────────────
    this._updateFacing(dt, intent);

    // ── drive the animation ──────────────────────────────────────────────
    this._drive(dt);

    this.model.position.copy(this.position);
    this.model.rotation.y = this.facing + this.modelYawOffset;
  }

  _accelerate(dt, dir, wantSpeed, authority) {
    const wantX = dir.x * wantSpeed;
    const wantZ = dir.z * wantSpeed;
    const rate = (wantSpeed > 0.01 ? this.T.accel : this.T.decel) * authority;
    const maxStep = rate * dt;

    const dx = wantX - this.velocity.x;
    const dz = wantZ - this.velocity.z;
    const d = Math.hypot(dx, dz);
    if (d <= maxStep || d < 1e-5) {
      this.velocity.x = wantX;
      this.velocity.z = wantZ;
    } else {
      this.velocity.x += (dx / d) * maxStep;
      this.velocity.z += (dz / d) * maxStep;
    }
  }

  _updateFacing(dt, intent) {
    if (this.state === 'slide') return;    // the slide owns its facing
    // Hanging, climbing and cover all face the surface; nothing else may turn him.
    if (this.state === 'hang' || this.state === 'climb' || this.state === 'cover') return;

    let want = this.facing;
    let rate = this.T.turnRate;

    if (this.aiming) {
      // AIM MODE: the right stick owns the facing outright.
      want = this.aimYaw;
      rate = this.T.turnRateAim;
    } else if (intent > 0.05 && this.state !== 'melee') {
      // FREE MODE: face where he is going.
      want = Math.atan2(this._moveWorld.x, this._moveWorld.z);
    } else {
      return;
    }
    this.facing = moveTowardAngle(this.facing, want, rate * dt);
  }

  _drive(dt) {
    const a = this.anim;
    if (this.state === 'hang') {
      const t = this._alongSurface(this.ledge);
      const moving = Math.abs(t.input) > 0.15;
      a.hang(moving ? (t.side === 'right' ? 1 : -1) : 0);
      return;
    }
    if (this.state === 'cover') {
      const t = this._alongSurface(this.cover);
      const moving = Math.abs(t.input) > 0.15;
      a.cover(moving ? (t.side === 'right' ? 1 : -1) : 0, this._coverSideHeld || 'right');
      return;
    }
    if (a.busy) {
      // An overlay is playing; the tree still gets asked for a pose so the
      // blend underneath is the right one when the overlay fades out.
      if (!this.grounded) a.air(this.velocity.y);
      else a.locomotion(this.speed, this._localMoveAngle(), this.speed * dt);
      return;
    }
    if (!this.grounded) {
      a.air(this.velocity.y);
    } else {
      a.locomotion(this.speed, this._localMoveAngle(), this.speed * dt);
    }
  }

  /** Travel direction expressed in the character's own frame: 0 = forward. */
  _localMoveAngle() {
    if (this.speed < 0.02) return 0;
    const worldAngle = Math.atan2(this.velocity.x, this.velocity.z);
    return wrapAngle(worldAngle - this.facing);
  }
}
