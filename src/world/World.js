// A deliberately blank white box world.
//
// Nothing here is scenery — every object exists to make MOTION readable. A
// featureless white plane gives the eye nothing to judge speed against, so the
// character looks like he is sliding on the spot no matter how good the
// animation is. The grid, the markers and the blocks are a measuring stick.

import * as THREE from '../../vendor/three/three.module.js';
import { toonMaterial, addOutline } from '../render/toon.js';

/** Grid squares are exactly 1 metre, so you can count them to check speed. */
const GRID_STEP = 1;
const GRID_EXTENT = 60;

export function buildWorld(scene) {
  scene.background = new THREE.Color(0xececf2);
  // Fog matched to the background so the grid dissolves instead of ending at a
  // hard visible edge.
  scene.fog = new THREE.Fog(0xececf2, 26, 68);

  const group = new THREE.Group();
  group.name = 'World';

  // ── ground ──────────────────────────────────────────────────────────────
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID_EXTENT * 2, GRID_EXTENT * 2),
    toonMaterial({ color: 0xf7f7fa, rimStrength: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.userData.noOutline = true;
  group.add(ground);

  // ── the metre grid ──────────────────────────────────────────────────────
  // Drawn as lines just above the floor. polygonOffset would work too, but a
  // small lift is simpler and cannot z-fight on a mobile depth buffer.
  const grid = new THREE.GridHelper(
    GRID_EXTENT * 2, (GRID_EXTENT * 2) / GRID_STEP, 0x8f8fa2, 0xc2c2d0
  );
  grid.position.y = 0.002;
  grid.material.transparent = true;
  grid.material.opacity = 0.9;
  group.add(grid);

  // ── ten-metre markers ───────────────────────────────────────────────────
  // Darker studs every 10m. Running between two of them and counting seconds
  // is how you check that runSpeed is actually the speed it claims to be.
  const markerMat = toonMaterial({ color: 0xc9c9d4, rimStrength: 0 });
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
  const blockMat = toonMaterial({ color: 0xffffff, rimColor: 0xffe6c2, rimStrength: 0.35 });
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
  }

  addOutline(group, { color: 0x1a1a24, thickness: 0.03, minSize: 0.35 });

  scene.add(group);
  return group;
}
