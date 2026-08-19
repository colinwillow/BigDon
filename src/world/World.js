// A deliberately blank white box world.
//
// Nothing here is scenery — every object exists to make MOTION readable. A
// featureless white plane gives the eye nothing to judge speed against, so the
// character looks like he is sliding on the spot no matter how good the
// animation is. The grid, the markers and the blocks are a measuring stick.

import * as THREE from '../../vendor/three/three.module.js';
import { flatMaterial } from '../render/materials.js';
import { Collider } from './Collider.js';

/** Grid squares are exactly 1 metre, so you can count them to check speed. */
const GRID_STEP = 1;
const GRID_EXTENT = 60;

export function buildWorld(scene) {
  const collider = new Collider();
  scene.background = new THREE.Color(0xececf2);
  // Fog matched to the background so the grid dissolves instead of ending at a
  // hard visible edge.
  scene.fog = new THREE.Fog(0xececf2, 26, 68);

  const group = new THREE.Group();
  group.name = 'World';

  // ── ground ──────────────────────────────────────────────────────────────
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID_EXTENT * 2, GRID_EXTENT * 2),
    flatMaterial({ color: 0xe4e4ec })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.userData.noOutline = true;
  group.add(ground);

  // ── the metre grid ──────────────────────────────────────────────────────
  // Drawn as lines just above the floor. polygonOffset would work too, but a
  // small lift is simpler and cannot z-fight on a mobile depth buffer.
  const grid = new THREE.GridHelper(
    GRID_EXTENT * 2, (GRID_EXTENT * 2) / GRID_STEP, 0x7d7d92, 0xb0b0c2
  );
  grid.position.y = 0.002;
  grid.material.transparent = true;
  grid.material.opacity = 0.9;
  group.add(grid);

  // ── ten-metre markers ───────────────────────────────────────────────────
  // Darker studs every 10m. Running between two of them and counting seconds
  // is how you check that runSpeed is actually the speed it claims to be.
  const markerMat = flatMaterial({ color: 0x9c9cae });
  const markerGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.04, 12);
  for (let x = -40; x <= 40; x += 10) {
    for (let z = -40; z <= 40; z += 10) {
      if (x === 0 && z === 0) continue;
      const m = new THREE.Mesh(markerGeo, markerMat);
      m.position.set(x, 0.02, z);
      m.userData.noOutline = true;
      group.add(m);
    }
  }

  // ── blocks, ramps and steps ─────────────────────────────────────────────
  // Something to run around, judge scale against, and cast shadows onto. The
  // step heights are chosen against the 1.8m character: 0.45 is knee height,
  // 0.9 is waist, 1.8 is exactly his own height.
  const blockMat = flatMaterial({ color: 0xf4f4fa });
  const blocks = [
    [3.5, 0.45, 3.5, 2.0, 0.9, 2.0],
    [-4.5, 0.45, 2.5, 1.4, 0.9, 1.4],
    [-3.0, 0.9, -4.0, 2.4, 1.8, 2.4],
    [6.5, 0.225, -3.0, 3.0, 0.45, 3.0],
    [0.0, 1.35, 8.0, 5.0, 2.7, 1.2],
    [-8.0, 0.45, -8.0, 1.0, 0.9, 6.0],
  ];
  for (const [x, y, z, w, h, d] of blocks) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), blockMat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    collider.addBox(x, y, z, w, h, d);
  }

  // ── a wall too tall to jump ─────────────────────────────────────────────
  // 5m, against a 4m jump apex. Anything he can clear is a hurdle, not a ledge,
  // so hanging only has anything to do until you build something taller than
  // the jump. This is also the cover wall.
  {
    const w = 9, h = 5, d = 1.2, x = 9.5, z = -6;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), blockMat);
    m.position.set(x, h / 2, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    collider.addBox(x, h / 2, z, w, h, d);
  }

  // ── a staircase ─────────────────────────────────────────────────────────
  // Four 0.3m risers. Below the controller's stepHeight, so he should walk
  // straight up without jumping and without catching on any edge — the single
  // most telling test of whether step-up is working.
  for (let i = 0; i < 4; i++) {
    const h = 0.3 * (i + 1);
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.6, h, 1.2), blockMat);
    m.position.set(-7.5, h / 2, 4.0 + i * 1.2);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    collider.addBox(-7.5, h / 2, 4.0 + i * 1.2, 1.6, h, 1.2);
  }

  // ── a pillar ring ───────────────────────────────────────────────────────
  // Radial landmarks. Circling them is the quickest way to see whether the
  // camera's yaw lag and the character's turn rate are fighting each other.
  const pillarGeo = new THREE.CylinderGeometry(0.22, 0.22, 3.2, 10);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const m = new THREE.Mesh(pillarGeo, blockMat);
    m.position.set(Math.sin(a) * 16, 1.6, Math.cos(a) * 16);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    // Boxed, not round: a 10-sided pillar is close enough to its own bounding
    // box that the difference is invisible, and it keeps the whole world on one
    // exact collision path.
    collider.addBox(Math.sin(a) * 16, 1.6, Math.cos(a) * 16, 0.44, 3.2, 0.44);
  }

  scene.add(group);
  return { group, collider };
}
