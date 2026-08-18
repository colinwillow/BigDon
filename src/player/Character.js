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
import { CLIPS, TUNING } from './clips.js';
import { clamp, clamp01, damp, wrapAngle, angleDelta, moveTowardAngle } from '../core/math.js';

const UP = new THREE.Vector3(0, 1, 0);

export class Character {
  /**
   * @param {THREE.Object3D} model  normalised GLB scene (feet at y=0, 1.8m tall)
   * @param {THREE.AnimationClip[]} clips
   */
  constructor(model, clips) {
    this.model = model;
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
    this.state = 'ground';       // ground | air | dash | melee | land
    this._stateT = 0;
    this._oneShotEnds = 0;

    this._coyote = 0;
    this._jumpBuffered = -1;
    this._dashCooldown = 0;
    this._dashDir = new THREE.Vector3();
    this._meleeDir = new THREE.Vector3();
    this._comboIndex = 0;
    this._comboT = 0;

    /**
     * Corrects a model whose bind pose does not face +Z. Measured once at load
     * (see normaliseModel) rather than hard-coded, so re-exporting the GLB from
     * a different tool does not silently mirror the character.
     */
    this.modelYawOffset = model.userData.yawOffset || 0;

    this._moveWorld = new THREE.Vector3();
  }

  get speedRatio() { return clamp01(this.speed / this.T.runSpeed); }

  /** Flat ground for now. One place to swap in a real height query. */
  groundAt(/* x, z */) { return 0; }

  // ── the verbs, called from Input ─────────────────────────────────────────

  /** Right-stick tap. Buffered, so pressing just before landing still fires. */
  requestJump() {
    this._jumpBuffered = this.T.jumpBuffer;
  }

  /** Left-stick flick: a dodge roll in the flicked direction. */
  requestDash(worldAngle) {
    if (this._dashCooldown > 0) return false;
    if (this.state === 'dash') return false;
    this._dashCooldown = this.T.dashCooldown + this.T.dashDuration;
    this._dashDir.set(Math.sin(worldAngle), 0, Math.cos(worldAngle));
    // A roll commits its facing to the roll direction — rolling sideways while
    // facing forward would need a clip set this model does not have.
    this.facing = worldAngle;
    this._enter('dash');
    this._oneShotEnds = this.anim.play(CLIPS.dash);
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
    if (this.state === 'dash') return false;
    const combo = CLIPS.meleeCombo;
    // The window is checked against the combo timer, not against being mid-
    // swing: a chain has to survive the swing ending, or the second hit only
    // lands if you flick during the first one's animation.
    if (this._comboT <= 0) this._comboIndex = 0;
    else this._comboIndex = (this._comboIndex + 1) % combo.length;
    this._comboT = this.T.comboWindow;
    if (worldAngle != null) this.facing = worldAngle;
    // Lunge along the FACING, which the line above has just set to the flick
    // direction — so he steps into wherever you swung.
    this._meleeDir.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    this._enter('melee');
    this._oneShotEnds = this.anim.play(combo[this._comboIndex]);
    return true;
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
    this._stateT += dt;
    this._dashCooldown = Math.max(0, this._dashCooldown - dt);
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
      case 'dash': {
        // A roll owns the velocity outright — stick input during it is ignored,
        // which is what makes it read as a committed move rather than a nudge.
        const t = clamp01(this._stateT / this.T.dashDuration);
        const curve = 1 - t * t;            // fast out, easing to nothing
        this.velocity.x = this._dashDir.x * this.T.dashSpeed * curve;
        this.velocity.z = this._dashDir.z * this.T.dashSpeed * curve;
        if (this._stateT >= Math.min(this.T.dashDuration, this._oneShotEnds)) {
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
      case 'air':
        this._accelerate(dt, this._moveWorld, wantSpeed, this.T.airControl);
        break;
      default:
        this._accelerate(dt, this._moveWorld, wantSpeed, 1);
        break;
    }

    // ── jump ─────────────────────────────────────────────────────────────
    const canJump = (this.grounded || this._coyote > 0)
      && this.state !== 'dash' && this.state !== 'melee';
    if (this._jumpBuffered >= 0 && canJump) {
      this.velocity.y = this.T.jumpSpeed;
      this.grounded = false;
      this._coyote = 0;
      this._jumpBuffered = -1;
      this.anim.endOneShot();
      this.anim.enterAir();
      this._enter('air');
    }

    // ── gravity + ground ─────────────────────────────────────────────────
    if (!this.grounded) this.velocity.y -= this.T.gravity * dt;

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    const groundY = this.groundAt(this.position.x, this.position.z);
    if (this.position.y <= groundY) {
      this.position.y = groundY;
      if (!wasGrounded && this.velocity.y < -1) {
        // Landed. A hard landing gets the plant; a small hop just carries on,
        // because interrupting a run with a landing animation every time he
        // clears a kerb is worse than no landing animation at all.
        if (this.velocity.y < -7 && this.state !== 'dash') {
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
    if (this.state === 'dash') return;      // the roll owns its facing

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
