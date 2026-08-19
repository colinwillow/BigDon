// Wires the two sticks to the character's verbs, and maps screen space into
// world space.
//
// ── THE VERB MAP ──────────────────────────────────────────────────────────
//
//   LEFT stick   push   walk / run (deflection picks the gait)
//                flick  dodge roll in the flicked direction
//                tap    recentre the camera behind him
//
//   RIGHT stick  push   AIM: he turns to face the stick, camera swings behind,
//                       and past the trigger zone he shoots
//                flick  melee (chains into a combo on repeat flicks)
//                tap    jump
//
// Keyboard/mouse is a dev convenience so this is playable on a laptop; the
// phone is the real target and the sticks are the real design.

import * as THREE from '../../vendor/three/three.module.js';
import { Joystick } from './Joystick.js';
import { clamp } from '../core/math.js';

export class Input {
  constructor(dom, cam) {
    this.cam = cam;
    this.left = new Joystick(dom.zoneLeft, dom.knobLeft, dom.ringLeft, {
      floating: true, radius: 64,
    });
    this.right = new Joystick(dom.zoneRight, dom.knobRight, dom.ringRight, {
      floating: true, radius: 64, shootStick: true,
    });

    /** Set by the consumer — see the verb map above. */
    this.onJump = null;
    this.onMelee = null;      // (worldAngle)
    this.onSlide = null;      // (worldAngle)
    this.onRecentre = null;

    this.left.onTap = () => this.onRecentre && this.onRecentre();
    this.left.onFlick = (screenAngle) => {
      if (this.onSlide) this.onSlide(this.screenToWorldAngle(screenAngle));
    };
    this.right.onTap = () => this.onJump && this.onJump();
    this.right.onFlick = (screenAngle) => {
      if (this.onMelee) this.onMelee(this.screenToWorldAngle(screenAngle));
    };

    // ── keyboard / mouse ────────────────────────────────────────────────
    this.keys = new Set();
    this._mouseDx = 0;
    this._mouseDown = false;
    this._bindKbm();

    /** Filled every sample(). */
    this.move = new THREE.Vector3();
    this.moveMag = 0;
    this.aiming = false;
    this.aimYaw = 0;
    this.shooting = false;
    this.lookDx = 0;
    this.lookX = 0;
  }

  _bindKbm() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space' && this.onJump) this.onJump();
      if (e.code === 'KeyV' && this.onMelee) this.onMelee(null);
      if (e.code === 'KeyR' && this.onRecentre) this.onRecentre();
      if (e.code === 'ShiftLeft' && this.onSlide) {
        const a = this._keyMoveAngle();
        if (a !== null) this.onSlide(a);
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    window.addEventListener('mousedown', (e) => {
      if (e.button === 0) this._mouseDown = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this._mouseDown = false;
    });
    window.addEventListener('mousemove', (e) => {
      // Only while dragging, so the camera doesn't drift on idle mouse travel.
      if (e.buttons & 2 || (e.buttons & 1)) this._mouseDx += e.movementX || 0;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Keyboard move vector in SCREEN space (y down), or null if no keys. */
  _keyVector() {
    let x = 0, y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (x === 0 && y === 0) return null;
    const l = Math.hypot(x, y);
    return { x: x / l, y: y / l };
  }

  _keyMoveAngle() {
    const v = this._keyVector();
    if (!v) return null;
    return this.screenToWorldAngle(Math.atan2(v.y, v.x));
  }

  /**
   * Turn a SCREEN-space angle (as the sticks report it, y down) into a world
   * heading, taking the camera's yaw into account. This one conversion is what
   * makes "push the stick that way" mean "go that way on screen" no matter
   * where the camera is pointing — get it wrong and the controls feel mirrored
   * or rotated, which players read as the character being broken.
   */
  screenToWorldAngle(screenAngle) {
    const sx = Math.cos(screenAngle);
    const sy = Math.sin(screenAngle);
    const yaw = this.cam.yaw;
    const wx = sx * Math.cos(yaw) + sy * Math.sin(yaw);
    const wz = -sx * Math.sin(yaw) + sy * Math.cos(yaw);
    return Math.atan2(wx, wz);
  }

  /** Same conversion, but keeping the magnitude. */
  _screenToWorld(sx, sy, out) {
    const yaw = this.cam.yaw;
    out.x = sx * Math.cos(yaw) + sy * Math.sin(yaw);
    out.y = 0;
    out.z = -sx * Math.sin(yaw) + sy * Math.cos(yaw);
    return out;
  }

  /** Once per frame, before the character updates. */
  sample() {
    // poll() has to run every frame on both sticks even when untouched: it is
    // what resolves flick candidates and hold clocks, and it returns the swipe
    // pixels the camera is allowed to use.
    const leftSwipe = this.left.poll();
    this.right.poll();

    // ── movement ────────────────────────────────────────────────────────
    const key = this._keyVector();
    let sx = this.left.x, sy = this.left.y, mag = this.left.mag;
    if (key && mag < 0.02) { sx = key.x; sy = key.y; mag = 1; }
    this._screenToWorld(sx, sy, this.move);
    this.moveMag = mag;

    // ── aim / shoot ─────────────────────────────────────────────────────
    // The right stick's DIRECTION is the aim. Any real deflection turns him;
    // past the trigger zone (Joystick's SHOOT_ZONE) it also shoots.
    const rmag = this.right.mag;
    this.aiming = rmag >= Joystick.camDeadzone;
    this.shooting = this.right.shootActive || this._mouseDown;
    if (this.aiming) {
      this.aimYaw = this.screenToWorldAngle(this.right.angle);
    }

    // ── camera ──────────────────────────────────────────────────────────
    // The left stick never pans; only its swipe-through does nothing here, so
    // the camera's manual input is the mouse plus Q/E on desktop.
    this.lookDx = this._mouseDx;
    this._mouseDx = 0;
    void leftSwipe;
    this.lookX = (this.keys.has('KeyE') ? 1 : 0) - (this.keys.has('KeyQ') ? 1 : 0);
  }

  /** Layout the parked sticks for the current screen. Call on resize. */
  layout() {
    const w = window.innerWidth, h = window.innerHeight;
    // Portrait puts the thumbs higher up the screen than landscape does,
    // because the hands wrap the sides rather than the bottom corners.
    const by = h - (h > w ? h * 0.16 : h * 0.22);
    this.left.park(w * 0.18, by);
    this.right.park(w * 0.82, by);
  }
}
