// Deterministic controller checks. These step Character directly at a fixed dt,
// so nothing here depends on frame rate, the GPU, or the model file.
//
// A warning inherited from Peggy, worth repeating: it is entirely possible for
// a suite like this to pass while movement runs BACKWARDS, because every check
// measures distance and none measures direction. Several checks below exist
// only to pin down direction and handedness. When you add one, ask what it
// would still pass with.

import * as THREE from '../vendor/three/three.module.js';
import { Character } from '../src/player/Character.js';
import { TUNING } from '../src/player/clips.js';
import { wrapAngle } from '../src/core/math.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  — ' + detail : '')); }
};
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

/** A Character with a bare Object3D and no clips — pure controller logic. */
function makeChar() {
  const model = new THREE.Object3D();
  model.add(new THREE.Object3D());
  return new Character(model, []);
}

/** Step for `secs` at a fixed 60Hz with a constant input. */
function run(c, secs, input) {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(secs / dt); i++) {
    c.update(dt, {
      moveX: 0, moveZ: 0, aiming: false, aimYaw: 0, ...input,
    });
    c.anim.update(dt);
  }
}

console.log('\nmovement');
{
  // DIRECTION, not just distance. "Stick north" is -Z in this world (the camera
  // looks down -Z at yaw 0), and a sign flip here is the single easiest bug to
  // ship: everything still moves, it just moves the wrong way.
  const c = makeChar();
  run(c, 1.0, { moveZ: -1 });
  ok('full stick north travels -Z', c.position.z < -1, `z=${c.position.z.toFixed(2)}`);
  ok('full stick north does not drift in X', near(c.position.x, 0, 1e-6));

  const c2 = makeChar();
  run(c2, 1.0, { moveX: 1 });
  ok('full stick east travels +X', c2.position.x > 1, `x=${c2.position.x.toFixed(2)}`);
}
{
  const c = makeChar();
  run(c, 2.0, { moveZ: -1 });
  ok('full deflection reaches runSpeed', near(c.speed, TUNING.runSpeed, 0.05),
    `speed=${c.speed.toFixed(2)} want=${TUNING.runSpeed}`);
}
{
  // Deflection below runAt must be a WALK, not a slow run. This is the gait
  // split the whole animation tree is built on.
  const c = makeChar();
  run(c, 2.0, { moveZ: -0.5 });
  ok('half deflection stays at or below walk speed', c.speed <= TUNING.walkSpeed + 0.01,
    `speed=${c.speed.toFixed(2)} walk=${TUNING.walkSpeed}`);
  ok('half deflection actually moves', c.speed > 0.3, `speed=${c.speed.toFixed(2)}`);
}
{
  const c = makeChar();
  run(c, 1.5, { moveZ: -1 });
  run(c, 1.0, {});
  ok('releasing the stick stops him', near(c.speed, 0, 1e-6), `speed=${c.speed}`);
}

console.log('\nfacing');
{
  // FREE mode: he faces where he is going. facing is the angle whose forward is
  // (sin, cos), so travelling -Z must give facing = PI.
  const c = makeChar();
  run(c, 1.0, { moveZ: -1 });
  ok('free mode faces travel direction (-Z => PI)',
    near(Math.abs(wrapAngle(c.facing)), Math.PI, 0.02), `facing=${c.facing.toFixed(3)}`);

  const c2 = makeChar();
  run(c2, 1.0, { moveX: 1 });
  ok('free mode faces +X => PI/2',
    near(wrapAngle(c2.facing), Math.PI / 2, 0.02), `facing=${c2.facing.toFixed(3)}`);
}
{
  // AIM mode: facing comes from the aim stick and IGNORES travel. This coming
  // apart is the entire reason the strafe clips exist.
  const c = makeChar();
  run(c, 1.0, { moveZ: -1, aiming: true, aimYaw: Math.PI / 2 });
  ok('aim mode faces the aim, not the travel',
    near(wrapAngle(c.facing), Math.PI / 2, 0.02), `facing=${c.facing.toFixed(3)}`);
  ok('aim mode still travels -Z', c.position.z < -1, `z=${c.position.z.toFixed(2)}`);

  // Facing +X while travelling -Z means moving to his RIGHT. If this comes out
  // -PI/2 the strafe blend plays the left clip while he slides right, which
  // looks like the animation is broken rather than the maths.
  const local = c._localMoveAngle();
  ok('travel is on his right (+PI/2 local)', near(local, Math.PI / 2, 0.05),
    `local=${local.toFixed(3)}`);
}

console.log('\njump');
{
  const c = makeChar();
  c.requestJump();
  run(c, 0.1, {});
  ok('jump leaves the ground', c.position.y > 0 && !c.grounded, `y=${c.position.y.toFixed(3)}`);
  ok('jump enters air state', c.state === 'air', `state=${c.state}`);
  run(c, 2.0, {});
  ok('gravity brings him back to the floor', near(c.position.y, 0, 1e-6), `y=${c.position.y}`);
  ok('lands grounded', c.grounded === true);
}
{
  // The buffer: a jump pressed slightly before touchdown must still fire.
  const c = makeChar();
  c.requestJump();
  run(c, 0.35, {});
  const apex = c.position.y;
  ok('reaches a sensible apex', apex > 0.5 && apex < 2.5, `apex=${apex.toFixed(2)}`);
}
{
  // Coyote time: walking off a ledge leaves a moment where jump still works.
  const c = makeChar();
  c.grounded = false;
  c._coyote = TUNING.coyoteTime;
  c.state = 'air';
  c.requestJump();
  run(c, 1 / 60, {});
  ok('coyote time allows a late jump', c.velocity.y > 0, `vy=${c.velocity.y.toFixed(2)}`);
}

console.log('\ndash');
{
  const c = makeChar();
  const fired = c.requestDash(0);          // 0 => forward is +Z
  ok('dash fires when off cooldown', fired === true);
  ok('dash enters dash state', c.state === 'dash', `state=${c.state}`);
  run(c, 0.1, {});
  ok('dash travels +Z for angle 0', c.position.z > 0.2, `z=${c.position.z.toFixed(2)}`);
  ok('dash ignores the stick', near(c.position.x, 0, 1e-6), `x=${c.position.x}`);
  run(c, 1.0, {});
  ok('dash ends and returns to ground', c.state === 'ground', `state=${c.state}`);
}
{
  const c = makeChar();
  c.requestDash(0);
  const again = c.requestDash(0);
  ok('dash respects its cooldown', again === false);
}
{
  // Direction check for the dash, separate from distance.
  const c = makeChar();
  c.requestDash(Math.PI / 2);              // PI/2 => +X
  run(c, 0.12, {});
  ok('dash at PI/2 travels +X', c.position.x > 0.2, `x=${c.position.x.toFixed(2)}`);
  ok('dash at PI/2 does not travel Z', Math.abs(c.position.z) < 1e-6);
}

console.log('\nblend tree');
{
  // The tree must ask for the clip that matches the direction of travel.
  const c = makeChar();
  run(c, 1.0, { moveZ: -1 });
  const t = c.anim.target;
  // target is cleared at the end of each update, so drive one more frame and
  // read it before update() runs.
  c.update(1 / 60, { moveX: 0, moveZ: -1, aiming: false, aimYaw: 0 });
  ok('running forward asks for the forward run clip',
    (c.anim.target.get('running') || 0) > 0.5,
    `weights=${[...c.anim.target].map(([k, v]) => k + ':' + v.toFixed(2)).join(' ')}`);
  void t;
}
{
  const c = makeChar();
  run(c, 1.0, { moveZ: -1, aiming: true, aimYaw: Math.PI / 2 });
  c.update(1 / 60, { moveX: 0, moveZ: -1, aiming: true, aimYaw: Math.PI / 2 });
  ok('strafing right asks for the RIGHT strafe clip',
    (c.anim.target.get('right_strafe') || 0) > 0.5,
    `weights=${[...c.anim.target].map(([k, v]) => k + ':' + v.toFixed(2)).join(' ')}`);
  ok('strafing right does NOT ask for the left strafe clip',
    (c.anim.target.get('left_strafe') || 0) < 0.01);
}
{
  // Phase must advance with DISTANCE, not time — that is what stops foot
  // skating. Standing still with the clock running must not advance it.
  const c = makeChar();
  run(c, 0.5, { moveZ: -1 });
  const moved = c.anim.phase;
  run(c, 1.0, {});                        // decelerate to a stop
  const stopped = c.anim.phase;
  run(c, 0.5, {});                        // now genuinely still
  ok('phase does not advance while standing still', near(c.anim.phase, stopped, 1e-9),
    `phase=${c.anim.phase} stopped=${stopped}`);
  ok('phase advanced while moving', moved > 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
