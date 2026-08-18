// The toon look.
//
// Flat vibrant fills, hard-edged light, a warm rim so the silhouette pops off
// the background, and a black ink outline. Deliberately NOT a photoreal
// pipeline with the saturation cranked; the whole point is that shading reads
// as two or three solid tones, not a gradient.
//
// Built on MeshToonMaterial rather than a from-scratch ShaderMaterial, because
// that inherits three's shadows, fog and lighting for free and stays compatible
// with whatever the GLB exporter emits. The banding comes from a gradient map;
// the rim light is patched in via onBeforeCompile.
//
// Ported from Peggy, with one fix — see addOutline().

import * as THREE from '../../vendor/three/three.module.js';

/**
 * A 1D gradient map is what turns smooth N·L into hard bands. `stops` are the
 * band boundaries — three entries gives three tones, which is the sweet spot:
 * two reads flat, four starts looking like a gradient again.
 */
export function makeGradientMap(stops = [0.35, 0.62, 1.0], shades = [0.55, 0.82, 1.0]) {
  const n = 64;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let v = shades[shades.length - 1];
    for (let s = 0; s < stops.length; s++) {
      if (t <= stops[s]) { v = shades[s]; break; }
    }
    const b = Math.round(v * 255);
    data[i * 4 + 0] = b; data[i * 4 + 1] = b; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

let _gradient = null;
export function defaultGradient() {
  if (!_gradient) _gradient = makeGradientMap();
  return _gradient;
}

/**
 * Rim light, injected into the toon shader.
 *
 * This is what sells the look on a phone: a warm band around the edge of every
 * object facing away from the camera, so the character separates from the
 * background without an expensive post pass. Also banded — a smooth rim would
 * fight the flat fills everywhere else.
 */
function patchRim(material, { rimColor, rimPower, rimStrength }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: new THREE.Color(rimColor) };
    shader.uniforms.uRimPower = { value: rimPower };
    shader.uniforms.uRimStrength = { value: rimStrength };

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3 uRimColor;
         uniform float uRimPower;
         uniform float uRimStrength;`
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
         {
           vec3 V = normalize( vViewPosition );
           float f = 1.0 - clamp( dot( normalize( normal ), V ), 0.0, 1.0 );
           f = pow( f, uRimPower );
           // band it, so the rim matches the flat fills instead of smearing
           f = smoothstep( 0.45, 0.62, f );
           gl_FragColor.rgb += uRimColor * f * uRimStrength;
         }`
      );
    material.userData.shader = shader;
  };
  // Force a distinct program so materials with different rim settings don't
  // collide in three's shader cache.
  material.customProgramCacheKey = () =>
    `rim:${rimColor}:${rimPower}:${rimStrength}`;
}

/** The standard character/prop material. */
export function toonMaterial(opts = {}) {
  const {
    color = 0xffffff,
    map = null,
    gradientMap = defaultGradient(),
    rimColor = 0xffd9a0,
    rimPower = 2.2,
    rimStrength = 0.5,
    transparent = false,
    opacity = 1,
    side = THREE.FrontSide,
  } = opts;

  const mat = new THREE.MeshToonMaterial({
    color, map, gradientMap, transparent, opacity, side,
  });
  patchRim(mat, { rimColor, rimPower, rimStrength });
  return mat;
}

// ── OUTLINES ───────────────────────────────────────────────────────────────
// Inverted-hull: draw the mesh again, expanded along its normals, with front
// faces culled. Cheap, works on every phone GPU, and gives the hand-inked edge
// that cel shading needs. The alternative — a screen-space edge-detect post
// pass — costs a full-screen pass and misses interior lines.
//
// The expansion is scaled by view distance so distant objects don't end up
// wearing a fat black halo, and clamped so nearby ones don't lose the line.
//
// ── THE SKINNING FIX ───────────────────────────────────────────────────────
// Peggy's version of this shader read `position` directly. That is correct for
// a static mesh and silently WRONG for a skinned one: the vertex never gets
// pushed through the bone matrices, so the outline renders the character's BIND
// POSE — a T-posed black shell standing inside the animated character. Peggy's
// own cast is procedural geometry, so nothing there ever exercised the path.
//
// Big Don is a 65-bone skinned mesh, so the outline shader has to skin too. The
// chunks below are three's own skinning includes; `defines: { USE_SKINNING }`
// plus the shader's own `#include <skinning_pars_vertex>` pulls in the bone
// texture uniforms, and three feeds them automatically because the object being
// drawn is a real SkinnedMesh bound to the same skeleton.
const outlineVert = /* glsl */`
  #include <common>
  #include <skinning_pars_vertex>
  uniform float uThickness;
  void main() {
    // Skin the POSITION through the bone matrices...
    #include <begin_vertex>
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <skinning_vertex>

    // ...then expand along the SKINNED normal. Doing this in the other order
    // (expand at bind pose, then skin) shears the shell on bent joints.
    vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
    vec3 n = normalize( normalMatrix * objectNormal );
    // Scale WITH view depth, so the line holds a roughly constant pixel width:
    // an outline of fixed world thickness shrinks to nothing in the distance.
    // Normalised at 6m (about the follow-cam's boom length) so uThickness reads
    // directly as "world units at normal play distance".
    float depthScale = clamp( -mvPosition.z / 6.0, 0.45, 4.0 );
    mvPosition.xyz += n * uThickness * depthScale;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const outlineFrag = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  void main() { gl_FragColor = vec4( uColor, uOpacity ); }
`;

export function outlineMaterial({ color = 0x14121a, thickness = 0.02, opacity = 1, skinned = false } = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uThickness: { value: thickness },
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
    },
    vertexShader: outlineVert,
    fragmentShader: outlineFrag,
    side: THREE.BackSide,
    transparent: opacity < 1,
    depthWrite: true,
  });
  // three only uploads the bone matrices when the material declares skinning.
  if (skinned) mat.defines = { USE_SKINNING: '' };
  return mat;
}

/**
 * Give an object an ink outline. Returns the outline objects so they can be
 * removed later. Skinned meshes get a SkinnedMesh outline sharing the same
 * skeleton AND a skinning-aware shader, so the line deforms with the animation.
 */
export function addOutline(target, opts = {}) {
  const { minSize = 0.06, ...matOpts } = opts;

  // Two materials, because the skinned variant needs a different #define and a
  // ShaderMaterial's defines are baked into its compiled program.
  let staticMat = null;
  let skinnedMat = null;

  // Collect first, then attach. Adding children mid-traverse would have the
  // traversal walk into the outlines it just created.
  const sources = [];
  target.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (o.userData.noOutline || o.userData.isOutline) return;
    // Skip tiny details. An ink line around a pupil reads as dirt at any sane
    // screen size, and each one is another draw call.
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    if (o.geometry.boundingSphere.radius < minSize) return;
    sources.push(o);
  });

  const created = [];
  for (const o of sources) {
    let clone;
    if (o.isSkinnedMesh) {
      if (!skinnedMat) skinnedMat = outlineMaterial({ ...matOpts, skinned: true });
      clone = new THREE.SkinnedMesh(o.geometry, skinnedMat);
      clone.bind(o.skeleton, o.bindMatrix);
      // The outline must not re-run the host's frustum test with its own
      // (bind-pose) bounds — an animated character reaching outside them pops.
      clone.frustumCulled = false;
    } else {
      if (!staticMat) staticMat = outlineMaterial({ ...matOpts, skinned: false });
      clone = new THREE.Mesh(o.geometry, staticMat);
    }
    // Parent the outline TO the mesh it outlines, with an identity local
    // transform, so it inherits the world matrix for free.
    //
    // The alternative (a flat sibling group that copies matrixWorld in an
    // onBeforeRender hook) silently does nothing: Group is never a render item,
    // so the renderer never calls its onBeforeRender, and the outlines stay
    // parked at the origin where you cannot see them.
    clone.userData.isOutline = true;
    clone.castShadow = false;
    clone.receiveShadow = false;
    o.add(clone);
    created.push(clone);
  }
  return created;
}

/**
 * Scene lighting for the toon look: one strong warm key that casts the shadows,
 * a cool sky/ground hemisphere for bounce, and a dim fill from behind so the
 * unlit side never goes to mud. Three lights, no more — banded shading falls
 * apart the moment several keys overlap and produce half-bands.
 */
export function setupLights(scene, opts = {}) {
  const {
    keyColor = 0xfff3d8,
    keyIntensity = 1.62,
    skyColor = 0xdfeaff,
    groundColor = 0xb9b9c4,
    hemiIntensity = 0.80,
    fillColor = 0xc4d4ff,
    fillIntensity = 0.32,
    shadowExtent = 14,
    shadowMapSize = 2048,
  } = opts;

  const key = new THREE.DirectionalLight(keyColor, keyIntensity);
  key.position.set(9, 14, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 60;
  // Tight, and it follows the player. A wide shadow camera spreads the same
  // 2048 texels over the whole level and every shadow turns to mush; a tight
  // one keeps them crisp where you're actually looking.
  const s = shadowExtent;
  key.shadow.camera.left = -s;
  key.shadow.camera.right = s;
  key.shadow.camera.top = s;
  key.shadow.camera.bottom = -s;
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.035;
  scene.add(key);
  scene.add(key.target);

  const hemi = new THREE.HemisphereLight(skyColor, groundColor, hemiIntensity);
  scene.add(hemi);

  const fill = new THREE.DirectionalLight(fillColor, fillIntensity);
  fill.position.set(-8, 5, -9);
  scene.add(fill);

  return { key, hemi, fill };
}
