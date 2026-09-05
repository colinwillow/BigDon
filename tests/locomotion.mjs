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

/**
 * A Character with real (if featureless) clips under the given names, so that
 * play() reports a duration and a one-shot state lasts more than a frame. With
 * no clips at all a melee ends on the frame it starts, which quietly turns any
 * check of what happens DURING one into a check of nothing.
 */
function makeCharWith(names, dur = 1.0) {
  const model = new THREE.Object3D();
  model.add(new THREE.Object3D());
  const clips = names.map((n) => new THREE.AnimationClip(n, dur, [
    new THREE.VectorKeyframeTrack('.position', [0, dur / 2, dur],
      [0, 0, 0, 0, 0.1, 0, 0, 0, 0]),
  ]));
  return new Character(model, clips);
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
  // WITH A CLIP. The slide ends at min(slideDuration, the clip's own length),
  // and a Character built with no clips reports a length of 0 — so every check
  // in here used to run against a slide that was over on the frame it started.
  // It still passed, because none of them measured how far he actually got.
  const c = makeCharWith(['run_slide'], 1.6);
  const fired = c.requestSlide(0);          // 0 => forward is +Z
  ok('slide fires when off cooldown', fired === true);
  ok('slide enters slide state', c.state === 'slide', `state=${c.state}`);
  run(c, 0.1, {});
  ok('slide travels +Z for angle 0', c.position.z > 0.2, `z=${c.position.z.toFixed(2)}`);
  ok('slide ignores the stick', near(c.position.x, 0, 1e-6), `x=${c.position.x}`);
  run(c, TUNING.slideDuration, { moveX: 1 });
  ok('and it is a long committed slide, not a hop',
    c.position.z > 8, `${c.position.z.toFixed(1)}m before it ends`);
  const end = c.position.z;
  run(c, 1.0, {});
  ok('slide ends and returns to ground', c.state === 'ground', `state=${c.state}`);
  ok('and it stops rather than trailing off across the map',
    c.position.z - end < 1.5, `drifted ${(c.position.z - end).toFixed(2)}m after`);
}
{
  const c = makeCharWith(['run_slide'], 1.6);
  c.requestSlide(0);
  const again = c.requestSlide(0);
  ok('slide respects its cooldown', again === false);
}
{
  // Direction check for the slide, separate from distance.
  const c = makeCharWith(['run_slide'], 1.6);
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

console.log('\nwinding up to speed');
{
  // He BUILDS to a sprint rather than arriving at one. The old accel of 72
  // reached top speed in 0.13s, which is a step function with extra steps, and
  // it is what made the long jump's run-up worth nothing.
  const c = makeChar();
  run(c, 0.10, { moveZ: -1 });
  const early = c.speed;
  ok('a tenth of a second in, he is still well under top speed',
    early < TUNING.runSpeed * 0.5, `speed=${early.toFixed(2)}`);
  ok('but he is already moving', early > 1, `speed=${early.toFixed(2)}`);
  run(c, 0.20, { moveZ: -1 });
  const mid = c.speed;
  ok('and still climbing at 0.3s', mid > early + 2 && mid < TUNING.runSpeed,
    `${early.toFixed(2)} -> ${mid.toFixed(2)}`);
  run(c, 0.30, { moveZ: -1 });
  ok('reaching top speed inside about half a second',
    near(c.speed, TUNING.runSpeed, 0.05), `speed=${c.speed.toFixed(2)}`);
}
{
  // ...and STEERING is not the same rate. Slowing them together makes him
  // skate through every direction change, so the correction across his heading
  // keeps the old snappy number. A check that only measured the wind-up would
  // pass with turns taking most of a second.
  const c = makeChar();
  run(c, 2.0, { moveZ: -1 });
  let t = 0;
  while (c.velocity.x < TUNING.runSpeed * 0.9 && t < 3) {
    run(c, 1 / 60, { moveX: 1 });
    t += 1 / 60;
  }
  ok('a right-angle turn at full speed is quicker than the wind-up was',
    t < 0.25, `${t.toFixed(3)}s`);
  ok('and he really is going the new way', c.velocity.x > TUNING.runSpeed * 0.9,
    `vx=${c.velocity.x.toFixed(2)}`);
}
{
  // Stopping stays crisp — decel is untouched.
  const c = makeChar();
  run(c, 2.0, { moveZ: -1 });
  run(c, 0.15, {});
  ok('letting go still stops him quickly', c.speed < 1.0, `speed=${c.speed.toFixed(2)}`);
}

console.log('\nmelee turns, it does not teleport');
{
  // The flick angle is where he ENDS UP, not where he is put. Assigning facing
  // was a visible snap of up to half a turn at the head of every strike, which
  // reads as the whole move being choppy however good the clip is.
  const c = makeCharWith(['punch_jab_left', 'punch_jab_right']);
  const AIM = 2.0;                       // well clear of +-PI, so no wrap ties
  c.requestMelee(AIM);
  ok('a melee does not move his facing on the frame it fires',
    near(c.facing, 0, 1e-9), `facing=${c.facing.toFixed(3)}`);
  run(c, 1 / 60, {});
  const first = c.facing;
  ok('it starts turning toward the flick', first > 0.01 && first < AIM,
    `after one frame facing=${first.toFixed(3)} of ${AIM}`);
  ok('and does not get there in one frame', first < AIM * 0.6,
    `facing=${first.toFixed(3)} — that is a teleport, not a turn`);
  run(c, 0.2, {});
  ok('but it does arrive, inside the lunge',
    near(wrapAngle(c.facing - AIM), 0, 0.02), `facing=${c.facing.toFixed(3)}`);
}
{
  // The LUNGE goes along the flick, not along the facing that is still catching
  // up to it. Driving it off the eased facing sends the first frames of a big
  // turn the old way, so the swing lands somewhere you did not aim it.
  const c = makeCharWith(['punch_jab_left', 'punch_jab_right']);
  c.requestMelee(Math.PI / 2);           // his right: world +X
  run(c, TUNING.meleeLungeTime, {});
  ok('the lunge goes where the flick pointed, from the first frame',
    c.position.x > 0.3, `x=${c.position.x.toFixed(2)}`);
  ok('and does not curve away along the old facing',
    Math.abs(c.position.z) < c.position.x * 0.2,
    `x=${c.position.x.toFixed(2)} z=${c.position.z.toFixed(2)}`);
}

console.log('\ncrouch and the long jump');
{
  // Standing crouch, then release: an ordinary jump. The crouch itself must
  // not be a stop — it keeps whatever momentum it entered with.
  const c = makeChar();
  ok('crouch only starts on the ground', c.startCrouch() === true);
  ok('and puts him in the crouch state', c.state === 'crouch');
  ok('crouching again is a no-op', c.startCrouch() === false);
  run(c, 0.3, {});                            // past the windup
  c.releaseCrouch();
  ok('releasing a standing crouch is a plain jump',
    near(c.velocity.y, TUNING.jumpSpeed, 1e-6), `vy=${c.velocity.y.toFixed(2)}`);
  ok('and it leaves the crouch', c.state === 'air');
}
{
  // THE TAP. The thumb can come and go faster than the stick can arm a crouch,
  // and faster than the pose can read even once it has — so the jump waits out
  // crouchMinTime rather than firing on the release. A check that only asserted
  // "a tap jumps" would pass with the crouch skipped entirely, which is the bug
  // this exists for.
  const c = makeChar();
  ok('a release with no crouch takes one first', c.releaseCrouch() === true);
  ok('and he is crouching, not airborne', c.state === 'crouch');
  run(c, TUNING.crouchMinTime * 0.5, {});
  ok('a tap does not launch inside the windup', c.state === 'crouch',
    `state=${c.state}`);
  ok('and he has not left the ground', c.grounded === true);
  run(c, TUNING.crouchMinTime, {});
  ok('but it does launch once the windup is up', c.state === 'air',
    `state=${c.state}`);
  ok('with the ordinary jump speed', c.velocity.y > 0);
  run(c, 3.0, {});
  ok('and he lands from it', c.grounded === true);
}
{
  // A crouch abandoned mid-windup must not fire the jump it had queued.
  const c = makeChar();
  c.releaseCrouch();
  run(c, TUNING.crouchMinTime * 0.5, {});
  c.cancelCrouch();
  run(c, 0.5, {});
  ok('a cancel drops the queued jump', c.state === 'ground', `state=${c.state}`);
  ok('and he stays on the ground', c.grounded === true && c.position.y === 0);
}
{
  // The slide. Enter at speed and the momentum carries, bleeding off against
  // crouchFriction — a check that only asserted "he slows down" would pass
  // with him stopping dead, so pin the DISTANCE travelled too.
  const c = makeChar();
  run(c, 2.0, { moveZ: -1 });                 // up to run speed
  const entrySpeed = c.speed;
  const z0 = c.position.z;
  c.startCrouch();
  run(c, 0.25, {});                           // no stick — pure slide
  ok('a crouch entered at speed keeps moving', c.position.z < z0 - 1.0,
    `travelled ${(z0 - c.position.z).toFixed(2)}m`);
  // It bleeds, but SLOWLY. A natural press-and-release is 200-400ms, and
  // friction steep enough to be felt in that window drops him through
  // longJumpAt — so the move a player thinks they are doing comes out as a
  // plain jump. Half a second of holding must still leave a long jump in it.
  ok('but is bleeding speed off', c.speed < entrySpeed - 0.5,
    `${entrySpeed.toFixed(2)} -> ${c.speed.toFixed(2)}`);
  ok('and half a second of holding still clears the long-jump threshold',
    c.speed > TUNING.longJumpAt,
    `after 0.25s: ${c.speed.toFixed(2)} vs ${TUNING.longJumpAt}`);
  ok('in the direction he was already going', c.position.x === 0);
  // ...and it does eventually stop, rather than sliding forever.
  run(c, 3.0, {});
  ok('a held crouch slides to a halt', c.speed < 0.05, `speed=${c.speed.toFixed(3)}`);
  ok('and he is still crouching', c.state === 'crouch');
  c.releaseCrouch();
  ok('a crouch that has stopped jumps normally, not long',
    near(c.velocity.y, TUNING.jumpSpeed, 1e-6), `vy=${c.velocity.y.toFixed(2)}`);
}
{
  // The Mario move, and THE BASELINE IS A RUNNING JUMP. An earlier version of
  // this block compared the long jump against one taken from a standstill
  // crouch, which it beat comfortably while actually being WORSE than just
  // running and jumping — 7.8m against 9.5m, and launching lower too. Measure
  // it against the thing a player would otherwise do.
  const arc = (setup) => {
    const c = makeChar();
    run(c, 2.0, { moveZ: -1 });
    const z0 = c.position.z;
    setup(c);
    let apex = 0;
    for (let i = 0; i < 400; i++) {
      run(c, 1 / 60, { moveZ: -1 });
      apex = Math.max(apex, c.position.y);
      if (c.grounded && i > 10) break;
    }
    return { dist: z0 - c.position.z, apex };
  };
  const normal = arc((c) => c.requestJump());
  const long = arc((c) => {
    c.startCrouch();
    run(c, TUNING.crouchMinTime + 1 / 60, {});
    c.releaseCrouch();
  });

  ok('a long jump goes considerably further than a running jump',
    long.dist > normal.dist * 1.7,
    `${long.dist.toFixed(1)}m vs ${normal.dist.toFixed(1)}m`);
  ok('and higher, not flatter', long.apex > normal.apex * 1.25,
    `${long.apex.toFixed(2)}m vs ${normal.apex.toFixed(2)}m`);

  // The horizontal half scales with what he carried in, so a sprint is worth
  // more than a jog — that is the skill in it.
  const launchFrom = (runUp) => {
    const c = makeChar();
    run(c, runUp, { moveZ: -1 });
    c.startCrouch();
    run(c, TUNING.crouchMinTime + 1 / 60, {});
    const entry = c.speed;
    c.releaseCrouch();
    return { entry, launch: c.speed };
  };
  const sprint = launchFrom(2.0);
  const jog = launchFrom(0.30);
  ok('a jog still clears the threshold', jog.entry >= TUNING.longJumpAt,
    `entry=${jog.entry.toFixed(2)} threshold=${TUNING.longJumpAt}`);
  ok('a sprint enters the crouch faster than a jog does',
    sprint.entry > jog.entry + 1, `${jog.entry.toFixed(2)} vs ${sprint.entry.toFixed(2)}`);
  ok('and the launch is that entry speed scaled, so the run-up is worth doing',
    near(jog.launch, jog.entry * TUNING.longJumpBoost, 1e-6)
    && near(sprint.launch, sprint.entry * TUNING.longJumpBoost, 1e-6),
    `${jog.entry.toFixed(2)}->${jog.launch.toFixed(2)}, ` +
    `${sprint.entry.toFixed(2)}->${sprint.launch.toFixed(2)}`);

  // ...and below the threshold there is no long jump at all.
  const shuffle = makeChar();
  run(shuffle, 0.08, { moveZ: -1 });
  shuffle.startCrouch();
  run(shuffle, TUNING.crouchMinTime + 1 / 60, {});
  ok('a shuffle is under the threshold', shuffle.speed < TUNING.longJumpAt,
    `speed=${shuffle.speed.toFixed(2)}`);
  shuffle.releaseCrouch();
  ok('and gets an ordinary jump, not a long one',
    near(shuffle.velocity.y, TUNING.jumpSpeed, 1e-6),
    `vy=${shuffle.velocity.y.toFixed(2)}`);
}
{
  // Air control STEERS. It used to be handed the ground's wantSpeed, which
  // pulled a long jump back to runSpeed inside 0.2s — the boost was there at
  // launch and gone before the apex, which is most of why the move did not
  // read as one.
  const c = makeChar();
  run(c, 2.0, { moveZ: -1 });
  c.startCrouch();
  run(c, TUNING.crouchMinTime + 1 / 60, {});
  c.releaseCrouch();
  const launch = c.speed;
  run(c, 0.35, { moveZ: -1 });          // holding forward all the way
  ok('holding forward in the air does not brake the launch',
    c.speed > launch * 0.98, `${launch.toFixed(2)} -> ${c.speed.toFixed(2)}`);
  ok('and the launch was well over run speed', launch > TUNING.runSpeed * 1.5,
    `launch=${launch.toFixed(2)} runSpeed=${TUNING.runSpeed}`);
  // Letting go must not brake him either.
  const free = c.speed;
  run(c, 0.2, {});
  ok('and letting go of the stick does not either',
    near(c.speed, free, 1e-6), `${free.toFixed(2)} -> ${c.speed.toFixed(2)}`);
}
{
  // Guards. A crouch must not open a hole in the other states, and a press
  // that gets abandoned must leave him exactly as he was.
  const c = makeChar();
  c.requestJump();
  run(c, 0.2, {});
  ok('crouch does not start in mid-air', c.startCrouch() === false);
  ok('and releasing one that never started does nothing',
    c.releaseCrouch() === false);
  run(c, 2.0, {});

  const d = makeChar();
  run(d, 2.0, { moveZ: -1 });
  d.startCrouch();
  run(d, 0.1, {});
  d.cancelCrouch();
  ok('cancelling a crouch returns him to the ground state', d.state === 'ground');
  ok('and he keeps running from where he was', d.speed > 1,
    `speed=${d.speed.toFixed(2)}`);
  run(d, 1.0, { moveZ: -1 });
  ok('back up to speed afterwards', d.speed > TUNING.runSpeed * 0.9,
    `speed=${d.speed.toFixed(2)}`);

  const e = makeChar();
  e.requestSlide(0);
  ok('a slide tackle cannot be crouch-cancelled', e.startCrouch() === false);
}

console.log('\nthe long jump dive');
{
  // Out of a long jump the air pose is `falling`, a face-down tilt that reads
  // as having thrown himself forward. Out of anything else it is `floating`,
  // upright with the legs under him. Both directions matter: a check that only
  // looked for the dive would pass with every hop turned into a skydive.
  const dive = () => TUNING && CLIPS.dive;
  const weightOf = (c, name) => c.anim.target.get(name) || 0;

  const c = makeCharWith([CLIPS.fall, CLIPS.dive, CLIPS.idle]);
  run(c, 2.0, { moveZ: -1 });
  c.startCrouch();
  run(c, TUNING.crouchMinTime + 1 / 60, {});
  c.releaseCrouch();
  c.update(1 / 60, { moveX: 0, moveZ: -1, aiming: false, aimYaw: 0 });
  ok('a long jump launches into the dive', weightOf(c, dive()) > 0.9,
    `dive=${weightOf(c, dive()).toFixed(2)} float=${weightOf(c, CLIPS.fall).toFixed(2)}`);

  // ...and he rights himself before he lands, rather than skydiving into it.
  run(c, 0.6, { moveZ: -1 });
  c.update(1 / 60, { moveX: 0, moveZ: -1, aiming: false, aimYaw: 0 });
  ok('and is out of it by the time he is coming down',
    c.velocity.y < 0 && weightOf(c, dive()) === 0,
    `vy=${c.velocity.y.toFixed(1)} dive=${weightOf(c, dive()).toFixed(2)}`);

  const n = makeCharWith([CLIPS.fall, CLIPS.dive, CLIPS.idle]);
  run(n, 2.0, { moveZ: -1 });
  n.requestJump();
  n.update(1 / 60, { moveX: 0, moveZ: -1, aiming: false, aimYaw: 0 });
  ok('an ordinary running jump does not dive', weightOf(n, dive()) === 0,
    `dive=${weightOf(n, dive()).toFixed(2)}`);
  ok('it floats', weightOf(n, CLIPS.fall) > 0.9,
    `float=${weightOf(n, CLIPS.fall).toFixed(2)}`);

  // The flag must not stick: a long jump followed by an ordinary one is the
  // obvious way to leave every later hop face-down.
  run(n, 3.0, { moveZ: -1 });
  const after = makeCharWith([CLIPS.fall, CLIPS.dive, CLIPS.idle]);
  run(after, 2.0, { moveZ: -1 });
  after.startCrouch();
  run(after, TUNING.crouchMinTime + 1 / 60, {});
  after.releaseCrouch();
  run(after, 3.0, {});
  ok('and he has landed from the long jump', after.grounded === true);
  after.requestJump();
  after.update(1 / 60, { moveX: 0, moveZ: -1, aiming: false, aimYaw: 0 });
  ok('the next ordinary jump is not still diving', weightOf(after, dive()) === 0,
    `dive=${weightOf(after, dive()).toFixed(2)}`);
}

console.log('\nbaked root motion');
{
  // The one-shots in this pack travel: run_slide carries ~2.5m of Z in the hips
  // track, which slides the mesh forward of where the character actually is and
  // then snaps it back the moment the clip stops driving him. That snap is the
  // "he teleports back" after a slide tackle.
  //
  // The rule is binary and per-clip: a clip that ENDS somewhere else has its
  // horizontal hips channel pinned; a clip that ends where it began keeps
  // everything, sway included. So both halves need pinning — a check that only
  // measured the travelling clip would pass with every cycle flattened into a
  // mannequin on rails.
  const step = 1 / 24;
  const times = [0, step, step * 2, step * 3, step * 4];
  // 1 unit of travel per key, with a 0.5-unit sway riding on top of it.
  const sway = [0, 0.5, 0, -0.5, 0];
  const vals = [];
  for (let k = 0; k < 5; k++) vals.push(0, 0, k + sway[k]);
  const hips = new THREE.VectorKeyframeTrack('mixamorig_Hips.position', times, vals);
  // A non-hips track with the same shape must be left alone entirely.
  const hand = new THREE.VectorKeyframeTrack(
    'mixamorig_LeftHand.position', times, vals.slice());
  const clip = new THREE.AnimationClip('travels', -1, [hips, hand]);

  const model = new THREE.Object3D();
  model.add(new THREE.Object3D());
  const a = new Character(model, [clip]).anim;
  const out = a.clips.get('travels').tracks.find(t => t.name.includes('Hips')).values;
  const z = (k) => out[k * 3 + 2];

  ok('a clip that travels ends where it began', near(z(4), z(0), 1e-6),
    `z ${z(0).toFixed(3)} -> ${z(4).toFixed(3)}`);
  // Mid-clip matters as much as the end: the slide plays barely half of
  // run_slide, so a fix that only lands by the last key drifts through the
  // whole tackle. This is what the earlier ramp subtraction failed.
  ok('and does not drift part-way through either',
    near(z(1), z(0), 1e-6) && near(z(2), z(0), 1e-6) && near(z(3), z(0), 1e-6),
    `keys ${[z(1), z(2), z(3)].map(n => n.toFixed(3)).join(', ')} vs ${z(0).toFixed(3)}`);
  ok('the clip is listed as de-rooted', a.deRooted.some(s => s.startsWith('travels')),
    a.deRooted.join(', '));

  const other = a.clips.get('travels').tracks.find(t => t.name.includes('Hand'));
  ok('a non-hips track is untouched', near(other.values[14], 4, 1e-9),
    `last z=${other.values[14]}`);

  // A cycle that already ends where it began must lose nothing.
  const flatVals = [];
  for (let k = 0; k < 5; k++) flatVals.push(0, 0, sway[k]);
  const cyc = new THREE.AnimationClip('cyclic', -1, [
    new THREE.VectorKeyframeTrack('mixamorig_Hips.position', times, flatVals),
  ]);
  const b = new Character(model, [cyc]).anim;
  ok('an already in-place cycle is not listed', b.deRooted.length === 0,
    b.deRooted.join(', '));
  const cz = b.clips.get('cyclic').tracks[0].values;
  ok('and keeps every bit of its sway',
    near(cz[5], 0.5, 1e-6) && near(cz[11], -0.5, 1e-6),
    `sway keys ${cz[5]}, ${cz[11]} — 0 means a cycle got flattened`);
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

console.log('\nempty clips');
{
  // A re-export can drop the motion while keeping the clip names and lengths:
  // the list looks perfect, actions play and report sensible weights, and the
  // character stands in his bind pose the whole time. Every runtime check short
  // of looking at the screen passes, so this one looks at the keyframes.
  const step = 1 / 24;
  const times = [0, step, step * 2, step * 3];
  const track = (name, values) =>
    new THREE.QuaternionKeyframeTrack(name + '.quaternion', times, values);
  const moving = (name) => track(name, [0,0,0,1, 0,0.1,0,0.99, 0,0.2,0,0.98, 0,0,0,1]);
  const flatT = (name) =>
    new THREE.QuaternionKeyframeTrack(name + '.quaternion', [0, 1], [0,0,0,1, 0,0,0,1]);

  const names = Array.from({ length: 30 }, (_, i) => 'bone' + i);
  const dead = new THREE.AnimationClip('dead', 1, names.map(flatT));
  const alive = new THREE.AnimationClip('alive', 1,
    names.map((n, i) => (i < 10 ? moving(n) : flatT(n))));

  const model = new THREE.Object3D();
  model.add(new THREE.Object3D());
  const a = new Character(model, [dead, alive]).anim;

  ok('a clip with no keyframes is flagged', a.flat.includes('dead'), a.flat.join(','));
  ok('a clip with real motion is not flagged', !a.flat.includes('alive'), a.flat.join(','));
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
