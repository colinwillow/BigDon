// Rig geometry: measuring a skinned character that has been posed.
//
// Kept separate from loadCharacter.js on purpose — that file pulls in
// GLTFLoader, which imports the bare specifier 'three' and so cannot be loaded
// straight into node. Everything here is pure maths over an Object3D tree, so
// the tests can exercise it headlessly against a synthetic rig, which is
// exactly what the facing bug needed and did not have.

import * as THREE from '../../vendor/three/three.module.js';

const UP = new THREE.Vector3(0, 1, 0);

/** How tall Big Don should be, in metres. */
export const TARGET_HEIGHT = 1.8;

/**
 * World-space bounds of a hierarchy that may contain SKINNED meshes.
 *
 * THREE.Box3.setFromObject is the obvious call and it is WRONG for a skinned
 * mesh: it measures the geometry's bind-pose box through the mesh node's own
 * matrixWorld, but a skinned mesh's vertices are placed by the BONES — the mesh
 * node's transform does not move them. SkinnedMesh.computeBoundingBox() walks
 * the vertices through the bone matrices instead, and its result agrees with
 * sampling the skinned vertices directly.
 */
export function skinnedBounds(root) {
  // updateMatrixWorld, NOT updateWorldMatrix. They are different methods, and
  // SkinnedMesh overrides only this one — its override is what recomputes
  // bindMatrixInverse from the current matrixWorld. Call the other and every
  // skinned vertex is transformed by a stale inverse, which is how the
  // measurement came out 150x wrong.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().makeEmpty();
  const tmp = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (o.userData.isOutline) return;
    if (o.isSkinnedMesh) {
      o.skeleton.update();
      o.computeBoundingBox();
      if (!o.boundingBox) return;
      tmp.copy(o.boundingBox);
    } else {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      if (!o.geometry.boundingBox) return;
      tmp.copy(o.geometry.boundingBox);
    }
    tmp.applyMatrix4(o.matrixWorld);
    box.union(tmp);
  });
  return box;
}

/**
 * Scale the character to a real-world height and drop him so his soles sit on
 * y=0. Returns the scale that was applied.
 *
 * ── WHY THIS CANNOT RUN AT LOAD TIME ──────────────────────────────────────
 * This GLB exports the armature at 0.01 scale but leaves the skinned mesh's
 * bindMatrix at identity. The consequence is that the character's skinned size
 * is only truthful once the live AnimationMixer is driving the bones: measured
 * straight after load, the same mesh measures 0.006m, and measured one frame
 * into playback it measures the 0.90m he actually renders at — a factor of 150.
 *
 * Normalising against the load-time number made Big Don 5.6m tall with his feet
 * a metre underground, which then read as "the camera is wrong" and "the
 * outline is missing" (a 14mm ink line on a 5.6m character is invisible).
 *
 * So: call this AFTER at least one anim.update(). It measures what is actually
 * on screen, which is the only measurement that cannot lie.
 */
export function normaliseHeight(root, targetHeight = TARGET_HEIGHT) {
  const inner = root.children[0] || root;
  const box = skinnedBounds(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (!(size.y > 1e-6)) return 1;

  const scale = targetHeight / size.y;
  inner.scale.multiplyScalar(scale);

  const box2 = skinnedBounds(root);
  inner.position.y -= box2.min.y;
  return scale;
}

/**
 * Measure the rig's forward axis from its hips and return the yaw correction
 * that turns it to face +Z.
 *
 * Falls back to 0 on a rig without recognisable hip joints rather than
 * guessing — a wrong guess mirrors the character, which is much harder to spot
 * than no correction at all.
 */
export function measureYawOffset(scene) {
  const find = (re) => {
    let hit = null;
    scene.traverse((o) => { if (!hit && o.isBone && re.test(o.name)) hit = o; });
    return hit;
  };
  const left = find(/left.?upleg|leftthigh|left.?hip/i);
  const right = find(/right.?upleg|rightthigh|right.?hip/i);
  if (!left || !right) return 0;

  scene.updateWorldMatrix(true, true);
  const lp = new THREE.Vector3().setFromMatrixPosition(left.matrixWorld);
  const rp = new THREE.Vector3().setFromMatrixPosition(right.matrixWorld);

  // The character's own right, flattened to the ground plane.
  const rightAxis = rp.sub(lp);
  rightAxis.y = 0;
  if (rightAxis.lengthSq() < 1e-8) return 0;
  rightAxis.normalize();

  // up x right = forward. Check the handedness against three's own camera
  // rather than trusting intuition: its right is +X, its up is +Y, and it looks
  // down -Z. up x right = (0,1,0) x (1,0,0) = (0,0,-1), which is that forward.
  // The other order, right x up, gives +Z — the exact negation, which points the
  // character backwards and makes him moonwalk: travelling one way, facing the
  // other. Everything else still looks sane, which is what makes it nasty.
  const forward = new THREE.Vector3().crossVectors(UP, rightAxis).normalize();
  const forwardAngle = Math.atan2(forward.x, forward.z);
  // Rotate by -forwardAngle so forward lands on +Z, which is what facing=0 means.
  return -forwardAngle;
}
