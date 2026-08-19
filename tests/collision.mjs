// Collision checks. Deterministic, fixed dt, no browser.
//
// The cases here are the ones that break silently: a wall that stops him but
// also cancels his fall, a fast drop that tunnels through a platform, a kerb
// that catches, and a push-out that sends him diagonally around a corner.

import * as THREE from '../vendor/three/three.module.js';
import { Collider } from '../src/world/Collider.js';
import { Character } from '../src/player/Character.js';
import { TUNING } from '../src/player/clips.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  — ' + detail : '')); }
};
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

function makeChar(collider) {
  const model = new THREE.Object3D();
  model.add(new THREE.Object3D());
  return new Character(model, [], collider);
}
function run(c, secs, input) {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(secs / dt); i++) {
    c.update(dt, { moveX: 0, moveZ: 0, aiming: false, aimYaw: 0, ...input });
    c.anim.update(dt);
  }
}

console.log('\nwalls');
{
  // A wall at z = 4, 4m wide, 3m tall. Running into it must stop him OUTSIDE it.
  const col = new Collider().addBox(0, 1.5, 4, 4, 3, 0.5);
  const c = makeChar(col);
  run(c, 2.0, { moveZ: 1 });
  const faceOfWall = 4 - 0.25;                    // wall's near side
  ok('he stops at the wall instead of passing through',
    c.position.z < faceOfWall, `z=${c.position.z.toFixed(3)}`);
  ok('he stops touching it, not short of it',
    c.position.z > faceOfWall - TUNING.radius - 0.05,
    `z=${c.position.z.toFixed(3)} expected about ${(faceOfWall - TUNING.radius).toFixed(3)}`);
  ok('running into a wall does not launch him', near(c.position.y, 0, 1e-6),
    `y=${c.position.y}`);
}
{
  // Sliding: pushed diagonally into a wall, the blocked axis stops but the free
  // one keeps going. If the push-out used the vector to the closest point he
  // would get flicked sideways instead.
  const col = new Collider().addBox(0, 1.5, 4, 12, 3, 0.5);
  const c = makeChar(col);
  run(c, 1.5, { moveX: 1, moveZ: 1 });
  ok('he slides along a wall rather than sticking', c.position.x > 3,
    `x=${c.position.x.toFixed(2)}`);
}

console.log('\nfloors and platforms');
{
  // Land on a 2m platform.
  const col = new Collider().addBox(0, 1, 3, 4, 2, 4);
  const c = makeChar(col);
  c.position.set(0, 3.5, 3);
  run(c, 1.5, {});
  ok('he lands on the platform top, not the floor', near(c.position.y, 2, 1e-3),
    `y=${c.position.y.toFixed(3)}`);
  ok('he is grounded up there', c.grounded === true);
}
{
  // TUNNELLING. A thin platform and a big drop: testing only the final position
  // each frame drops him straight through it.
  const col = new Collider().addBox(0, 2, 0, 6, 0.2, 6);
  const c = makeChar(col);
  c.position.set(0, 12, 0);
  run(c, 2.5, {});
  ok('a fast fall does not tunnel through a thin platform',
    near(c.position.y, 2.1, 1e-2), `y=${c.position.y.toFixed(3)}`);
}
{
  // Walking off an edge must drop him.
  const col = new Collider().addBox(0, 1, 0, 4, 2, 4);
  const c = makeChar(col);
  c.position.set(0, 2, 0);
  run(c, 2.0, { moveX: 1 });
  ok('walking off a platform falls to the floor', near(c.position.y, 0, 1e-6),
    `y=${c.position.y.toFixed(3)}`);
  ok('and he ends up past its edge', c.position.x > 2, `x=${c.position.x.toFixed(2)}`);
}

console.log('\nstep-up');
{
  // A kerb below stepHeight is walked onto, not collided with.
  //
  // Timed to stop while he is still ON it. At 9.6 m/s two seconds carries him
  // 19m — clean across a 4m kerb and off the far side — so the first version of
  // this check read y=0 and looked like step-up had failed when it had actually
  // worked and then correctly dropped him off the other end.
  const col = new Collider().addBox(0, 0.15, 3, 4, 0.3, 4);   // spans z 1..5
  const c = makeChar(col);
  run(c, 0.45, { moveZ: 1 });
  ok('he walks up a low kerb without jumping', near(c.position.y, 0.3, 1e-3),
    `y=${c.position.y.toFixed(3)}`);
  ok('and is still up on top of it', c.position.z > 2 && c.position.z < 5,
    `z=${c.position.z.toFixed(2)}`);
  ok('he never left the ground doing it', c.grounded === true);
}
{
  // Anything above stepHeight is a wall.
  const tall = TUNING.stepHeight + 0.5;
  const col = new Collider().addBox(0, tall / 2, 3, 4, tall, 4);
  const c = makeChar(col);
  run(c, 1.0, { moveZ: 1 });
  ok('a ledge taller than stepHeight blocks him', c.position.z < 3,
    `z=${c.position.z.toFixed(2)} (should not have climbed a ${tall.toFixed(2)}m ledge)`);
  ok('and he does not get lifted by it', near(c.position.y, 0, 1e-6),
    `y=${c.position.y.toFixed(3)}`);
}

console.log('\nceilings');
{
  // Jumping under a low roof bonks rather than passing through.
  const col = new Collider().addBox(0, 2.6, 0, 6, 0.4, 6);
  const c = makeChar(col);
  c.requestJump();
  run(c, 1.2, {});
  ok('he cannot jump through a ceiling',
    c.position.y + TUNING.height <= 2.4 + 1e-3,
    `head at ${(c.position.y + TUNING.height).toFixed(3)}, ceiling at 2.4`);
}

console.log('\nno collider');
{
  // The headless controller tests run without a world; that must still work.
  const c = makeChar(null);
  run(c, 1.0, { moveZ: 1 });
  ok('a character with no collider still moves on a flat plane',
    c.position.z > 1 && near(c.position.y, 0, 1e-9), `z=${c.position.z.toFixed(2)}`);
}

console.log('\nledge hang');

// A 5m wall. This has to be TALLER than he can jump: with a 4.0m apex he sails
// clean over anything shorter, so a 2.4m block — the first version of this
// test — was never a ledge problem at all, it was a hurdle. Hanging is for
// what you cannot clear.
const wall = () => new Collider().addBox(0, 2.5, 3, 6, 5, 4);   // top 5, face z=1
/** Jump at the wall and run until he grabs it or we give up. */
function jumpAt(c, maxSecs = 2.0) {
  const dt = 1 / 60;
  c.requestJump();
  for (let i = 0; i < Math.round(maxSecs / dt); i++) {
    c.update(dt, { moveX: 0, moveZ: 1, aiming: false, aimYaw: 0 });
    c.anim.update(dt);
    if (c.state === 'hang') return true;
  }
  return false;
}

{
  const c = makeChar(wall());
  c.position.set(0, 0, -0.6);
  c.facing = 0;
  ok('he catches a wall he cannot jump over', jumpAt(c), `state=${c.state}`);
  ok('he hangs below the top, not on it',
    Math.abs(c.position.y - (5 - TUNING.hangDrop)) < 1e-6, `y=${c.position.y.toFixed(3)}`);
  ok('he hangs off the face, not inside the wall',
    c.position.z < 1 - TUNING.radius + 1e-6, `z=${c.position.z.toFixed(3)}`);
  ok('gravity does not drag him off', Math.abs(c.velocity.y) < 1e-9, `vy=${c.velocity.y}`);
  const y0 = c.position.y;
  run(c, 1.0, {});
  ok('he stays put while hanging', Math.abs(c.position.y - y0) < 1e-9,
    `slid ${(c.position.y - y0).toFixed(4)}m`);
}
{
  // Shimmy along the edge, and stop at its end.
  const c = makeChar(wall());
  c.position.set(0, 0, -0.6); c.facing = 0;
  jumpAt(c);
  const x0 = c.position.x;
  run(c, 0.6, { moveX: 1 });
  ok('shimmying moves him along the edge', c.position.x > x0 + 0.2,
    `x ${x0.toFixed(2)} -> ${c.position.x.toFixed(2)}`);
  run(c, 6.0, { moveX: 1 });
  ok('shimmy stops at the end of the edge',
    c.position.x <= 3 - TUNING.radius + 1e-6,
    `x=${c.position.x.toFixed(3)}, edge ends at 3`);
  ok('and he is still hanging there', c.state === 'hang', `state=${c.state}`);

  // ...and the other way, so a sign error cannot pass.
  run(c, 1.0, { moveX: -1 });
  ok('shimmying the other way goes the other way', c.position.x < 3 - TUNING.radius - 0.3,
    `x=${c.position.x.toFixed(3)}`);
}
{
  // Climb up: pushing INTO the wall pulls him onto the top.
  const c = makeChar(wall());
  c.position.set(0, 0, -0.6); c.facing = 0;
  jumpAt(c);
  // Climbing is the JUMP button now. Pushing into the wall used to do it, which
  // meant shimmying at a slight angle launched him onto the top by accident.
  run(c, 0.3, { moveZ: 1 });
  ok('pushing into the wall does NOT climb', c.state === 'hang', `state=${c.state}`);
  c.requestJump();
  run(c, TUNING.climbUpTime + 0.4, {});
  ok('jump climbs up', c.state === 'ground', `state=${c.state}`);
  ok('and he ends up standing on top', Math.abs(c.position.y - 5) < 1e-3,
    `y=${c.position.y.toFixed(3)}`);
  ok('standing ON it, not balanced on the lip', c.position.z > 1,
    `z=${c.position.z.toFixed(3)}, face at z=1`);
  ok('he is grounded up there', c.grounded === true);
}
{
  // Pulling AWAY drops him.
  const c = makeChar(wall());
  c.position.set(0, 0, -0.6); c.facing = 0;
  jumpAt(c);
  // Releasing is now held-and-firm, like leaving cover, so a wobble never drops
  // you off a ledge you meant to hang on.
  run(c, TUNING.coverExitHold * 0.5, { moveZ: -1 });
  ok('a brief pull does not drop him', c.state === 'hang', `state=${c.state}`);
  run(c, TUNING.coverExitHold + 0.1, { moveZ: -1 });
  ok('a sustained pull lets go', c.state !== 'hang', `state=${c.state}`);
  run(c, 2.0, {});
  ok('and he falls to the floor', Math.abs(c.position.y) < 1e-6,
    `y=${c.position.y.toFixed(3)}`);
}
{
  // A ledge with no room above must NOT be grabbable — pulling up into a
  // ceiling is worse than not grabbing at all.
  // The blocker has to be TALL, not a thin slab: a thin one has a grabbable
  // top of its own just above, and he simply catches that instead — which is
  // correct behaviour and makes the test pass for the wrong reason.
  const col = new Collider()
    .addBox(0, 2.5, 3, 6, 5, 4)          // the wall, top at 5
    .addBox(0, 8.65, 3, 6, 6.7, 4);      // spans 5.3 to 12, top far out of reach
  const c = makeChar(col);
  c.position.set(0, 0, -0.6); c.facing = 0;
  ok('a ledge with no headroom is not grabbed', !jumpAt(c), `state=${c.state}`);
}

console.log('\ncover');
{
  // Walking into a tall wall and pressing puts him flat against it.
  const col = new Collider().addBox(0, 1.5, 3, 6, 3, 0.6);   // face at z=2.7
  const c = makeChar(col);
  c.position.set(0, 0, 0);
  c.facing = 0;
  run(c, 1.2, { moveZ: 1 });
  ok('he reaches the wall', c.position.z > 2, `z=${c.position.z.toFixed(2)}`);
  const w = col.findWall(c.position.x, c.position.z, c.position.y, 0, 1,
    TUNING.radius, { reach: TUNING.coverReach, minHeight: TUNING.coverMinHeight });
  ok('a wall in front is detected', w !== null);
  c._tryCover();
  ok('pressing enters cover', c.state === 'cover', `state=${c.state}`);
  const z0 = c.position.z;
  run(c, 0.5, { moveX: 1 });
  ok('in cover he slides ALONG the wall', c.position.x > 0.2,
    `x=${c.position.x.toFixed(2)}`);
  ok('and never off it', Math.abs(c.position.z - z0) < 1e-6,
    `z drifted ${(c.position.z - z0).toFixed(4)}`);
  run(c, 0.4, { moveZ: -1 });
  ok('pulling away leaves cover', c.state !== 'cover', `state=${c.state}`);
}

{
  // Cover must be sticky: sliding along it is the whole point, so sideways
  // input can never release him and a brief wobble away must not either.
  const col = new Collider().addBox(0, 1.5, 3, 6, 3, 0.6);
  const c = makeChar(col);
  c.position.set(0, 0, 0); c.facing = 0;
  run(c, 1.2, { moveZ: 1 });
  c._tryCover();
  run(c, 1.0, { moveX: 1 });
  ok('sliding sideways never leaves cover', c.state === 'cover', `state=${c.state}`);
  run(c, TUNING.coverExitHold * 0.5, { moveZ: -1 });
  ok('a brief pull away does not leave cover', c.state === 'cover', `state=${c.state}`);
  run(c, TUNING.coverExitHold + 0.1, { moveZ: -1 });
  ok('a sustained pull away does leave it', c.state !== 'cover', `state=${c.state}`);
}
{
  // Jumping out of cover launches him UP the wall — the route from pressed
  // against a wall to hanging off its top.
  const col = new Collider().addBox(0, 2.5, 3, 6, 5, 4);
  const c = makeChar(col);
  c.position.set(0, 0, 0); c.facing = 0;
  run(c, 1.2, { moveZ: 1 });
  c._tryCover();
  ok('he is in cover on the tall wall', c.state === 'cover', `state=${c.state}`);
  c.requestJump();
  run(c, 1 / 60, {});
  ok('jumping leaves cover upward', c.velocity.y > 0, `vy=${c.velocity.y.toFixed(2)}`);
  const dt = 1 / 60;
  for (let i = 0; i < 120 && c.state !== 'hang'; i++) {
    c.update(dt, { moveX: 0, moveZ: 0.4, aiming: false, aimYaw: 0 });
    c.anim.update(dt);
  }
  ok('and that jump can reach the ledge', c.state === 'hang', `state=${c.state}`);
}

{
  // COVER FACING. The _left and _right takes are authored facing OPPOSITE ways
  // — they mean "the wall is on my left" / "on my right", not a lean. So he
  // stands PARALLEL to the wall, never facing into or away from it, and turns
  // to face whichever way he travels along it. Facing into the wall (the first
  // version) made him appear to spin round when the sided clip swapped.
  const col = new Collider().addBox(0, 1.5, 3, 6, 3, 0.6);   // face at z=2.7, normal -Z
  const c = makeChar(col);
  c.position.set(0, 0, 0); c.facing = 0;
  run(c, 1.2, { moveZ: 1 });
  c._tryCover();
  ok('entering cover faces along the wall, not into it',
    Math.abs(Math.abs(c.facing) - Math.PI / 2) < 1e-6,
    `facing=${c.facing.toFixed(3)} (should be +-PI/2, i.e. along X)`);

  run(c, 0.4, { moveX: 1 });
  const facingRight = c.facing;
  const sideRight = c._coverSideHeld;
  ok('travelling +X faces +X', Math.abs(facingRight - Math.PI / 2) < 1e-6,
    `facing=${facingRight.toFixed(3)}`);
  // Facing +X his right is +Z; the wall is at +Z, so it is on his right.
  ok('with the wall at +Z and facing +X, the wall is on his RIGHT',
    sideRight === 'right', `side=${sideRight}`);

  run(c, 0.4, { moveX: -1 });
  ok('travelling -X turns him to face -X',
    Math.abs(c.facing + Math.PI / 2) < 1e-6, `facing=${c.facing.toFixed(3)}`);
  ok('and now the wall is on his LEFT', c._coverSideHeld === 'left',
    `side=${c._coverSideHeld}`);

  // Releasing the stick must LEAVE him as he was, not snap him back.
  const held = c._coverSideHeld, facing = c.facing;
  run(c, 0.5, {});
  ok('letting go keeps the last facing', Math.abs(c.facing - facing) < 1e-6);
  ok('letting go keeps the last side', c._coverSideHeld === held);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
