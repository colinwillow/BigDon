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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
