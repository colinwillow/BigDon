// World collision.
//
// Everything solid in this game is an axis-aligned box, so the maths here is
// exact rather than an approximation — no physics engine, no broadphase beyond
// a bounds check, and it stays deterministic enough to test at a fixed dt.
//
// The player is treated as a VERTICAL CYLINDER: a circle in XZ, plus a height.
// A capsule would round the feet, which mostly matters for walking up slopes,
// and there are no slopes here. A cylinder against an AABB has a closed-form
// closest point, which is what makes the push-out stable instead of jittering
// between two boxes that share an edge.
//
// ── THE THREE THINGS THAT MAKE THIS FEEL RIGHT ────────────────────────────
//
//  * STEP-UP. A kerb you have to jump over is infuriating. Any surface within
//    `stepHeight` of the feet is climbed rather than collided with, so he walks
//    onto low ledges without the player thinking about it.
//
//  * SWEPT GROUND. He jumps 4m and falls at 32 m/s^2, so at a long frame he
//    covers most of a metre between two positions. Testing only the final
//    position lets him fall straight through a platform. The ground query takes
//    the whole span he moved through.
//
//  * AXIS-OF-LEAST-PENETRATION push-out. Pushing along the vector to the box's
//    closest point sends him diagonally when he is inside the footprint, which
//    reads as being flicked around corners. Resolving along the shallowest axis
//    slides him cleanly along the wall instead.

import * as THREE from '../../vendor/three/three.module.js';
import { clamp } from '../core/math.js';

/** Nothing is solid below this, so a query that finds nothing lands on y=0. */
const FLOOR_Y = 0;

export class Collider {
  constructor() {
    /** @type {THREE.Box3[]} */
    this.boxes = [];
  }

  /** Add a solid box from a centre and a size, matching how World builds them. */
  addBox(cx, cy, cz, sx, sy, sz) {
    const h = new THREE.Vector3(sx / 2, sy / 2, sz / 2);
    const c = new THREE.Vector3(cx, cy, cz);
    this.boxes.push(new THREE.Box3(c.clone().sub(h), c.clone().add(h)));
    return this;
  }

  /** Add every box-shaped mesh under an object. Used to keep the visual world
   *  and the collision world from drifting apart. */
  addFromObject(root) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh || !o.userData.solid) return;
      const b = new THREE.Box3().setFromObject(o);
      this.boxes.push(b);
    });
    return this;
  }

  /**
   * Highest solid surface under a circle, searched through the span the player
   * actually moved across this frame.
   *
   * `yFrom` is where the feet were, `yTo` where they are now. Anything whose top
   * lies in between counts as ground — that is what stops a fast fall tunnelling
   * through a platform.
   */
  groundAt(x, z, radius, yFrom, yTo) {
    // A small tolerance upward so standing exactly on a surface keeps finding it
    // rather than flickering between grounded and falling.
    const hi = Math.max(yFrom, yTo) + 1e-3;
    const lo = Math.min(yFrom, yTo) - 1e-3;
    let best = FLOOR_Y >= lo - 1e-3 ? FLOOR_Y : -Infinity;
    if (FLOOR_Y > hi) best = -Infinity;

    for (const b of this.boxes) {
      const top = b.max.y;
      if (top > hi || top < lo) continue;
      if (!this._overlapsXZ(b, x, z, radius)) continue;
      if (top > best) best = top;
    }
    return best === -Infinity ? FLOOR_Y : best;
  }

  /** Lowest solid underside above `y`, for bonking his head. */
  ceilingAt(x, z, radius, y) {
    let best = Infinity;
    for (const b of this.boxes) {
      if (b.min.y < y) continue;
      if (!this._overlapsXZ(b, x, z, radius)) continue;
      if (b.min.y < best) best = b.min.y;
    }
    return best;
  }

  /**
   * Push a cylinder out of anything it is inside, stepping up onto low ledges
   * rather than being stopped by them.
   *
   * Mutates `pos`. Returns what happened, so the controller can kill velocity
   * into a wall (otherwise he keeps accelerating into it and shoots along the
   * surface the moment it ends).
   */
  resolve(pos, radius, height, stepHeight) {
    const out = { hitWall: false, stepped: false, nx: 0, nz: 0 };

    // A few passes, because pushing out of one box can push into another —
    // inside corners need at least two. Three is enough for box worlds and
    // bounded, unlike looping until clear.
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;

      for (const b of this.boxes) {
        // Start the span slightly above the feet so the surface he is STANDING
        // on is never treated as a wall to be pushed out of.
        const spanLo = pos.y + 1e-3;
        const spanHi = pos.y + height;
        if (b.max.y <= spanLo || b.min.y >= spanHi) continue;
        if (!this._overlapsXZ(b, pos.x, pos.z, radius)) continue;

        // ── step up ────────────────────────────────────────────────────────
        const rise = b.max.y - pos.y;
        if (rise > 0 && rise <= stepHeight && this._headroom(pos, b.max.y, radius, height)) {
          pos.y = b.max.y;
          out.stepped = true;
          moved = true;
          continue;
        }

        // ── push out along the shallowest axis ────────────────────────────
        const px = radius + (b.max.x - b.min.x) / 2 - Math.abs(pos.x - (b.min.x + b.max.x) / 2);
        const pz = radius + (b.max.z - b.min.z) / 2 - Math.abs(pos.z - (b.min.z + b.max.z) / 2);
        if (px <= 0 || pz <= 0) continue;

        if (px < pz) {
          const dir = pos.x < (b.min.x + b.max.x) / 2 ? -1 : 1;
          pos.x += px * dir;
          out.nx = dir;
        } else {
          const dir = pos.z < (b.min.z + b.max.z) / 2 ? -1 : 1;
          pos.z += pz * dir;
          out.nz = dir;
        }
        out.hitWall = true;
        moved = true;
      }

      if (!moved) break;
    }
    return out;
  }

  /**
   * Look for a grabbable ledge in front of the character.
   *
   * Returns where to hang, which way the wall faces, and how far the edge runs
   * in each direction so shimmying can be clamped to it — or null.
   *
   * The band is measured against the FEET, not the head: what makes a ledge
   * grabbable is that his hands can reach the top, and expressing it in feet
   * terms keeps it comparable with stepHeight and jump apex, which are the
   * numbers you tune against.
   */
  findLedge(x, z, feetY, dirX, dirZ, radius, opts) {
    const { reach, bandLow, bandHigh, headroom } = opts;
    const probeX = x + dirX * (radius + reach);
    const probeZ = z + dirZ * (radius + reach);

    let best = null;
    for (const b of this.boxes) {
      const top = b.max.y;
      const rel = top - feetY;
      if (rel < bandLow || rel > bandHigh) continue;
      // The probe has to land on the box's footprint, which is what makes this
      // "the thing in front of me" rather than "any ledge at the right height".
      if (probeX < b.min.x - 0.05 || probeX > b.max.x + 0.05) continue;
      if (probeZ < b.min.z - 0.05 || probeZ > b.max.z + 0.05) continue;
      // There must be somewhere to climb TO. Grabbing the underside of a shelf
      // and then clipping into it on the way up is worse than not grabbing.
      if (!this._clearAbove(probeX, probeZ, top, radius, headroom, b)) continue;
      if (!best || top > best.max.y) best = b;
    }
    if (!best) return null;

    // Which face did he come at? Whichever axis he is furthest outside on.
    const outX = x < best.min.x ? -1 : (x > best.max.x ? 1 : 0);
    const outZ = z < best.min.z ? -1 : (z > best.max.z ? 1 : 0);
    const dX = outX ? Math.abs(x - (outX < 0 ? best.min.x : best.max.x)) : Infinity;
    const dZ = outZ ? Math.abs(z - (outZ < 0 ? best.min.z : best.max.z)) : Infinity;
    if (!outX && !outZ) return null;   // already inside the footprint

    if (dX <= dZ) {
      const faceX = outX < 0 ? best.min.x : best.max.x;
      return {
        top: best.max.y,
        x: faceX + outX * radius,
        z: clamp(z, best.min.z, best.max.z),
        nx: outX, nz: 0,
        minT: best.min.z, maxT: best.max.z,   // the edge runs along Z
      };
    }
    const faceZ = outZ < 0 ? best.min.z : best.max.z;
    return {
      top: best.max.y,
      x: clamp(x, best.min.x, best.max.x),
      z: faceZ + outZ * radius,
      nx: 0, nz: outZ,
      minT: best.min.x, maxT: best.max.x,     // the edge runs along X
    };
  }

  /** Room to stand on top of `except` at (x,z)? */
  _clearAbove(x, z, top, radius, headroom, except) {
    const lo = top + 1e-3;
    const hi = top + headroom;
    for (const b of this.boxes) {
      if (b === except) continue;
      if (b.max.y <= lo || b.min.y >= hi) continue;
      if (this._overlapsXZ(b, x, z, radius)) return false;
    }
    return true;
  }

  /**
   * Is there a wall directly in front, tall enough to press against?
   * Returns its outward normal and face position, or null.
   */
  findWall(x, z, feetY, dirX, dirZ, radius, opts) {
    const { reach, minHeight } = opts;
    const probeX = x + dirX * (radius + reach);
    const probeZ = z + dirZ * (radius + reach);
    for (const b of this.boxes) {
      if (b.max.y - feetY < minHeight) continue;      // too short to hide behind
      if (b.min.y > feetY + 0.5) continue;            // starts above his waist
      if (probeX < b.min.x - 0.02 || probeX > b.max.x + 0.02) continue;
      if (probeZ < b.min.z - 0.02 || probeZ > b.max.z + 0.02) continue;

      const outX = x < b.min.x ? -1 : (x > b.max.x ? 1 : 0);
      const outZ = z < b.min.z ? -1 : (z > b.max.z ? 1 : 0);
      const dX = outX ? Math.abs(x - (outX < 0 ? b.min.x : b.max.x)) : Infinity;
      const dZ = outZ ? Math.abs(z - (outZ < 0 ? b.min.z : b.max.z)) : Infinity;
      if (!outX && !outZ) continue;

      if (dX <= dZ) {
        return {
          x: (outX < 0 ? b.min.x : b.max.x) + outX * radius,
          z: clamp(z, b.min.z, b.max.z),
          nx: outX, nz: 0, minT: b.min.z, maxT: b.max.z,
        };
      }
      return {
        x: clamp(x, b.min.x, b.max.x),
        z: (outZ < 0 ? b.min.z : b.max.z) + outZ * radius,
        nx: 0, nz: outZ, minT: b.min.x, maxT: b.max.x,
      };
    }
    return null;
  }

  /** Is there room to stand with the feet at `feetY`? */
  _headroom(pos, feetY, radius, height) {
    const lo = feetY + 1e-3;
    const hi = feetY + height;
    for (const b of this.boxes) {
      if (b.max.y <= lo || b.min.y >= hi) continue;
      if (this._overlapsXZ(b, pos.x, pos.z, radius)) return false;
    }
    return true;
  }

  /** Circle-vs-rectangle overlap in the ground plane. */
  _overlapsXZ(b, x, z, radius) {
    const cx = clamp(x, b.min.x, b.max.x);
    const cz = clamp(z, b.min.z, b.max.z);
    const dx = x - cx;
    const dz = z - cz;
    return dx * dx + dz * dz < radius * radius;
  }
}
