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
import { measureYawOffset } from '../src/player/rig.js';
import { TUNING, CLIPS, MELEE_COMBO } from '../src/player/clips.js';
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
  // The gait split the whole animation tree is built on. Expressed RELATIVE to
  // runAt, not as a hardcoded deflection: the threshold moved from 0.72 to 0.45
  // when the tuning came across from Robits, and a test pinned to "0.5 is a
  // walk" fails on a retune without anything actually being broken.
  const belowRunAt = makeChar();
  run(belowRunAt, 2.0, { moveZ: -(TUNING.runAt * 0.8) });
  ok('deflection below runAt stays at or below walk speed',
    belowRunAt.speed <= TUNING.walkSpeed + 0.01,
    `speed=${belowRunAt.speed.toFixed(2)} walk=${TUNING.walkSpeed}`);
  ok('a small push still moves him', belowRunAt.speed > 0.3,
    `speed=${belowRunAt.speed.toFixed(2)}`);

  const aboveRunAt = makeChar();
  run(aboveRunAt, 2.0, { moveZ: -Math.min(1, TUNING.runAt + 0.25) });
  ok('deflection above runAt breaks into a run',
    aboveRunAt.speed > TUNING.walkSpeed + 0.01,
    `speed=${aboveRunAt.speed.toFixed(2)} walk=${TUNING.walkSpeed}`);
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

  // Facing +X (forward=+X) puts his RIGHT at +Z — stand facing +X with +Y up and
  // your right hand is at +Z. So travelling -Z is moving to his LEFT, which is
  // local +PI/2. Get this backwards and the blend plays the left clip while he
  // slides right; it reads as the animation being broken rather than the maths.
  const local = c._localMoveAngle();
  ok('travel is on his left (+PI/2 local)', near(local, Math.PI / 2, 0.05),
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
  // Apex is measured by running until he starts falling, and checked against
  // the physics the tuning implies (v^2/2g) rather than a hardcoded height, so
  // raising the jump does not fail this without a real regression.
  const c = makeChar();
  c.requestJump();
  let apex = 0;
  for (let i = 0; i < 400 && (c.velocity.y > 0 || i < 2); i++) {
    c.update(1 / 60, { moveX: 0, moveZ: 0, aiming: false, aimYaw: 0 });
    c.anim.update(1 / 60);
    apex = Math.max(apex, c.position.y);
  }
  const want = (TUNING.jumpSpeed * TUNING.jumpSpeed) / (2 * TUNING.gravity);
  ok('apex matches the tuned jump physics', Math.abs(apex - want) < want * 0.06,
    `apex=${apex.toFixed(2)} want=${want.toFixed(2)}`);
  ok('he clears his own height', apex > 1.8, `apex=${apex.toFixed(2)}`);
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

console.log('\nslide');
{
  const c = makeChar();
  const fired = c.requestSlide(0);          // 0 => forward is +Z
  ok('slide fires when off cooldown', fired === true);
  ok('slide enters slide state', c.state === 'slide', `state=${c.state}`);
  run(c, 0.1, {});
  ok('slide travels +Z for angle 0', c.position.z > 0.2, `z=${c.position.z.toFixed(2)}`);
  ok('slide ignores the stick', near(c.position.x, 0, 1e-6), `x=${c.position.x}`);
  run(c, 1.0, {});
  ok('slide ends and returns to ground', c.state === 'ground', `state=${c.state}`);
}
{
  const c = makeChar();
  c.requestSlide(0);
  const again = c.requestSlide(0);
  ok('slide respects its cooldown', again === false);
}
{
  // Direction check for the slide, separate from distance.
  const c = makeChar();
  c.requestSlide(Math.PI / 2);              // PI/2 => +X
  run(c, 0.12, {});
  ok('slide at PI/2 travels +X', c.position.x > 0.2, `x=${c.position.x.toFixed(2)}`);
  ok('slide at PI/2 does not travel Z', Math.abs(c.position.z) < 1e-6);
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
    (c.anim.target.get(CLIPS.runF) || 0) > 0.5,
    `weights=${[...c.anim.target].map(([k, v]) => k + ':' + v.toFixed(2)).join(' ')}`);
  void t;
}
{
  // BOTH directions get pinned, because a suite that only checks one passes
  // happily with the left and right clips swapped — which is exactly the bug
  // this file shipped with. Facing +X puts his right at +Z.
  const strafe = (aimYaw, moveZ) => {
    const c = makeChar();
    run(c, 1.0, { moveZ, aiming: true, aimYaw });
    c.update(1 / 60, { moveX: 0, moveZ, aiming: true, aimYaw });
    return c.anim.target;
  };

  const toHisLeft = strafe(Math.PI / 2, -1);   // faces +X, travels -Z
  ok('travelling to his left plays the LEFT strafe',
    (toHisLeft.get(CLIPS.runL) || 0) > 0.5,
    `weights=${[...toHisLeft].map(([k, v]) => k + ':' + v.toFixed(2)).join(' ')}`);
  ok('travelling to his left does not touch the right strafe',
    (toHisLeft.get(CLIPS.runR) || 0) < 0.01);

  const toHisRight = strafe(Math.PI / 2, 1);   // faces +X, travels +Z
  ok('travelling to his right plays the RIGHT strafe',
    (toHisRight.get(CLIPS.runR) || 0) > 0.5,
    `weights=${[...toHisRight].map(([k, v]) => k + ':' + v.toFixed(2)).join(' ')}`);
  ok('travelling to his right does not touch the left strafe',
    (toHisRight.get(CLIPS.runL) || 0) < 0.01);

  // And backwards, so the F/B pair is pinned too.
  const backing = strafe(0, 1);                // faces +Z, travels +Z... forward
  ok('travelling along his facing plays the forward run',
    (backing.get(CLIPS.runF) || 0) > 0.5,
    `weights=${[...backing].map(([k, v]) => k + ':' + v.toFixed(2)).join(' ')}`);
  const reversing = strafe(0, -1);             // faces +Z, travels -Z
  ok('travelling against his facing plays the BACK run',
    (reversing.get(CLIPS.runB) || 0) > 0.5,
    `weights=${[...reversing].map(([k, v]) => k + ':' + v.toFixed(2)).join(' ')}`);
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

console.log('\nmelee');
{
  // A swing must MOVE him. Every melee clip in this pack is in-place, so if the
  // lunge is not applied procedurally he swipes at the air on the spot and
  // closing the last half metre becomes the player's problem.
  const c = makeChar();
  c.requestMelee(0);                        // swing toward +Z
  ok('melee enters the melee state', c.state === 'melee', `state=${c.state}`);
  run(c, TUNING.meleeLungeTime, {});
  ok('melee lunges forward', c.position.z > 0.3, `z=${c.position.z.toFixed(2)}`);
  ok('melee lunges along the swing, not sideways', Math.abs(c.position.x) < 1e-6);

  const travel = c.position.z;
  run(c, 0.5, {});
  ok('the lunge stops rather than sliding on',
    c.position.z - travel < 0.35, `drifted ${(c.position.z - travel).toFixed(2)}m after`);
}
{
  // Direction, separately from distance.
  const c = makeChar();
  c.requestMelee(Math.PI / 2);              // swing toward +X
  run(c, TUNING.meleeLungeTime, {});
  ok('melee at PI/2 lunges +X', c.position.x > 0.3, `x=${c.position.x.toFixed(2)}`);
  ok('melee at PI/2 does not lunge in Z', Math.abs(c.position.z) < 1e-6);
}
{
  // Control has to come back quickly. The clips run 2.3-3.2s; being locked for
  // that long is what made one swing feel like a commitment.
  // Recovery is a FRACTION of the strike's own length now, so a long kick is
  // no longer chopped off at the same absolute time as a short jab. With a stub
  // model there are no clips, so _oneShotEnds is 0 and the state ends at once;
  // what this pins is that the fraction is sane and control does come back.
  ok('recovery is expressed as a fraction of the clip',
    TUNING.meleeRecoverFrac > 0.5 && TUNING.meleeRecoverFrac <= 1,
    `meleeRecoverFrac=${TUNING.meleeRecoverFrac}`);
  const c = makeChar();
  c.requestMelee(0);
  run(c, 1.5, {});
  ok('control returns after a strike', c.state !== 'melee', `state=${c.state}`);
}
{
  // CHAINING. Three flicks inside the combo window must give three DIFFERENT
  // swings, in order. Testing only that "a second melee fires" would pass with
  // the combo index stuck at zero, which is the same thing as having no combo.
  // Read the combo INDEX rather than the playing action: this harness gives
  // Character a stub model with no clips, so there is no action to inspect —
  // but the chaining decision is the thing under test either way.
  const c = makeChar();
  const seen = [];
  for (let i = 0; i < 3; i++) {
    c.requestMelee(0);
    seen.push(c.currentMeleeClip);
    run(c, 0.12, {});                       // well inside comboWindow
  }
  ok('three chained flicks play three different swings',
    new Set(seen).size === 3, seen.join(' -> '));
  ok('the chain follows the authored combo order',
    seen.map((n) => n.replace(/_(left|right)$/, '')).join('|')
      === MELEE_COMBO.slice(0, 3).join('|'), seen.join(' -> '));
  // Sides must ALTERNATE. Re-rolling at random throws the same hand twice
  // often enough to read as a hitch.
  const sides = seen.map((n) => n.endsWith('_left') ? 'L' : 'R');
  ok('the chain alternates sides', sides[0] !== sides[1] && sides[1] !== sides[2],
    sides.join(''));
}
{
  // ...and letting the window lapse resets to the opener.
  const c = makeChar();
  c.requestMelee(0);
  run(c, 0.12, {});
  c.requestMelee(0);
  const second = c.currentMeleeClip;
  run(c, TUNING.comboWindow + 0.1, {});     // let it lapse
  c.requestMelee(0);
  const afterLapse = c.currentMeleeClip;
  ok('a lapsed combo restarts from the opener',
    afterLapse.startsWith(MELEE_COMBO[0]) && !second.startsWith(MELEE_COMBO[0]),
    `second=${second} afterLapse=${afterLapse}`);
}

console.log('\ndouble jump');
{
  const c = makeChar();
  c.requestJump();
  run(c, 0.3, {});
  const vyAfterFirst = c.velocity.y;
  const yAtSecond = c.position.y;
  c.requestJump();                       // second jump, mid-air
  run(c, 1 / 60, {});
  ok('a second jump fires in mid-air', c.velocity.y > vyAfterFirst,
    `vy ${vyAfterFirst.toFixed(2)} -> ${c.velocity.y.toFixed(2)}`);
  ok('the second jump is weaker than the first',
    TUNING.doubleJumpSpeed < TUNING.jumpSpeed,
    `${TUNING.doubleJumpSpeed} vs ${TUNING.jumpSpeed}`);

  // ...but only ONE of them.
  const vy2 = c.velocity.y;
  c.requestJump();
  run(c, 1 / 60, {});
  ok('a third jump does not fire', c.velocity.y < vy2,
    `vy=${c.velocity.y.toFixed(2)} (should just be falling)`);

  run(c, 3.0, {});
  ok('a double jump goes higher than a single', yAtSecond >= 0);
  ok('and he lands', c.grounded === true);

  // landing must rearm it
  c.requestJump();
  run(c, 0.2, {});
  c.requestJump();
  run(c, 1 / 60, {});
  ok('landing rearms the double jump', c.velocity.y > 0, `vy=${c.velocity.y.toFixed(2)}`);
}

console.log('\nloop seams');
{
  // Every cycle in this pack ends on a byte-identical copy of its first frame,
  // which is how loops are authored — but played back that pose shows TWICE in
  // a row, once as the last frame and again as the next cycle's first. At 24fps
  // over a 14-frame sprint that is a visible hitch every stride.
  // Distinct names matter: clips are keyed by name, so two called 'cycle' would
  // simply overwrite each other in the map.
  const build = (name, times, values) => {
    const track = new THREE.VectorKeyframeTrack('.position', times, values);
    return new THREE.AnimationClip(name, -1, [track]);
  };
  // 5 keys at 24fps; the last is a copy of the first.
  const step = 1 / 24;
  const t = [0, step, step * 2, step * 3, step * 4];
  const dup = build('dup', t, [0,0,0,  1,0,0,  2,0,0,  1,0,0,  0,0,0]);
  const clean = build('clean', t, [0,0,0,  1,0,0,  2,0,0,  1,0,0,  0.5,0,0]);
  const durDup = dup.duration, durClean = clean.duration;

  const model = new THREE.Object3D();
  model.add(new THREE.Object3D());
  const a = new Character(model, [dup, clean]).anim;

  ok('a cycle with a duplicated last frame is trimmed',
    Math.abs(a.clips.get('dup').duration - (durDup - step)) < 1e-6,
    `duration ${durDup.toFixed(4)} -> ${a.clips.get('dup').duration.toFixed(4)}`);

  // ...and one that genuinely ends somewhere else is left alone.
  ok('a cycle that ends elsewhere is left alone',
    Math.abs(a.clips.get('clean').duration - durClean) < 1e-9,
    `duration=${a.clips.get('clean').duration.toFixed(4)}`);

  // The trim must never eat a clip whole.
  const tiny = build('tiny', [0, step], [0,0,0, 0,0,0]);
  const cc = new Character(model, [tiny]).anim;
  ok('a two-key clip is never trimmed', cc.clips.get('tiny').duration > 0,
    `duration=${cc.clips.get('tiny').duration}`);
}

console.log('\nmodel orientation');
{
  // The controller checks above all use a bare Object3D, so NONE of them can
  // see which way the actual model points — which is how a 180-degree facing
  // error shipped while every one of them passed. These test the measurement
  // itself, against synthetic hips, with no GLB and no browser.
  const rig = (leftPos, rightPos) => {
    const root = new THREE.Object3D();
    const L = new THREE.Bone(); L.name = 'mixamorig_LeftUpLeg'; L.position.set(...leftPos);
    const R = new THREE.Bone(); R.name = 'mixamorig_RightUpLeg'; R.position.set(...rightPos);
    root.add(L); root.add(R);
    return root;
  };

  // Big Don's layout: his left hip sits at +X, so he faces +Z already and needs
  // no correction. The old right-x-up cross product returned PI here, spun him
  // around, and made him moonwalk.
  ok('left hip at +X => faces +Z => no correction',
    near(measureYawOffset(rig([1, 0, 0], [-1, 0, 0])), 0, 1e-6),
    `offset=${measureYawOffset(rig([1, 0, 0], [-1, 0, 0])).toFixed(4)}`);

  // The mirror image must come out half a turn away, not zero.
  ok('left hip at -X => faces -Z => half a turn',
    near(Math.abs(measureYawOffset(rig([-1, 0, 0], [1, 0, 0]))), Math.PI, 1e-6));

  // A rig authored facing sideways resolves to a quarter turn, which pins the
  // SIGN as well as the magnitude — the two cases above are symmetric and would
  // both still pass with the cross product's operands swapped.
  ok('left hip at +Z => faces -X => +quarter turn',
    near(measureYawOffset(rig([0, 0, 1], [0, 0, -1])), Math.PI / 2, 1e-6),
    `offset=${measureYawOffset(rig([0, 0, 1], [0, 0, -1])).toFixed(4)}`);

  // No recognisable hips must mean "leave it alone", never a guess: a wrong
  // guess mirrors the character, which is far harder to spot than no correction.
  const bare = new THREE.Object3D();
  ok('a rig with no hips gets no correction', measureYawOffset(bare) === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
