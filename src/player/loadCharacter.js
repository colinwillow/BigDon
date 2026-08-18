// Load the character GLB, normalise it, and give it the toon look.
//
// Two things here are worth not hard-coding, because both silently break in
// ways that look like a bug in the movement code rather than a bug at load:
//
//  * SCALE. The file is authored ~0.83 units tall with the feet at y=0.044.
//    Every speed and distance in clips.js is in metres, so the model is scaled
//    to a real height and dropped so the feet sit exactly on y=0. Re-export the
//    GLB at a different scale and this still lands.
//
//  * FACING. A rig's bind pose does not have to face +Z, and this one does not.
//    Rather than a magic `rotation.y = Math.PI` that nobody can justify later,
//    the forward axis is MEASURED from the skeleton: the hip joints give the
//    character's right, and up x right is forward. Re-rig or re-export and it
//    still lands.

import * as THREE from '../../vendor/three/three.module.js';
import { GLTFLoader } from '../../vendor/three/addons/loaders/GLTFLoader.js';
import { toonMaterial, addOutline } from '../render/toon.js';
import { measureYawOffset } from './rig.js';

export { normaliseHeight, skinnedBounds } from './rig.js';

export async function loadCharacter(url, opts = {}) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const scene = gltf.scene;

  // NOTE: the character is NOT scaled here — see normaliseHeight() below, which
  // has to run after the animation system is live to get a truthful measurement.

  // ── work out which way he faces ──────────────────────────────────────────
  const yawOffset = measureYawOffset(scene);

  // The measured offset has to be applied INSIDE the wrapper, because the
  // wrapper's own rotation.y is what the controller drives every frame.
  const root = new THREE.Group();
  root.name = 'BigDon';
  root.add(scene);
  root.userData.yawOffset = 0;
  scene.rotation.y += yawOffset;

  // ── toon materials ──────────────────────────────────────────────────────
  const skinned = [];
  scene.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    // An animated character routinely reaches outside its bind-pose bounds;
    // three culls on those bounds and the character vanishes at screen edges.
    o.frustumCulled = false;
    if (o.isSkinnedMesh) skinned.push(o);

    const old = o.material;
    o.material = toonMaterial({
      color: opts.color ?? 0xffffff,
      map: old && old.map ? old.map : null,
      rimColor: 0xffe6c2,
      rimPower: 2.4,
      rimStrength: 0.42,
    });
    if (old && old.dispose) old.dispose();
  });

  addOutline(root, {
    color: opts.outlineColor ?? 0x14121a,
    thickness: opts.outlineThickness ?? 0.032,
    minSize: 0.05,
  });

  return { root, clips: gltf.animations, skinned, yawOffset };
}


