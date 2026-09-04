// The look: bright, flat, self-illuminated. No toon shader, no ink lines.
//
// Ported from what Robits actually does, because that is the reference this
// game is chasing. Three moves, and they only work together:
//
//  1. THE TEXTURE LIGHTS ITSELF. The base colour map is fed back in as an
//     EMISSIVE map at roughly full strength. The character's own paint becomes
//     the light source, so his colours read at full saturation regardless of
//     where the key light is. This is what "bright and vibrant" actually means
//     here — not turning the lights up, which just washes everything toward
//     white and flattens the texture's own contrast.
//
//  2. NOTHING IS SHINY. metalness 0, roughness 1. A GLB exported from most
//     tools arrives with mid metalness/roughness, which gives every surface a
//     moving specular hotspot — that is the "weird reflection" that makes a
//     hand-painted texture look like wet plastic. Killing it is what makes the
//     surface read as flat.
//
//  3. ACES TONE MAPPING, exposure 1.1. Counter-intuitive next to an emissive
//     texture, but NoToneMapping clips every bright pixel to flat white and the
//     highlights lose all their detail. ACES rolls them off, which is most of
//     why Robits looks graded and crisp rather than blown out.
//
// The lighting below is deliberately soft and low-contrast: with the texture
// already emitting, the lights only need to add enough directional shaping to
// keep the silhouette from going completely flat, plus cast the ground shadow.

import * as THREE from '../../vendor/three/three.module.js';

/** How hard the base texture self-illuminates when a model ships NO emissive of
 *  its own. 1 = fully lit by its own paint. */
export const EMISSIVE = 0.92;

/**
 * Multiplier applied to whatever emissive a model DOES ship.
 *
 * big_donny carries an emissiveFactor of 0.6, which on top of the key light and
 * ACES at exposure 1.1 blows his mid-tones out — the paint stops reading as
 * shaded material and starts reading as a lamp. Scaling it down keeps the
 * saturation the emissive is there for without flattening the form.
 *
 * At the shipped 0.6 his hair washes to near-white; 0.25 of it (about 0.15
 * effective) keeps the saturation without losing the shading. Set this to 0 to
 * disable self-illumination entirely and let the lights do all the work — the
 * form reads best there, at the cost of some vibrancy.
 */
export const EMISSIVE_SCALE = 0.25;

/**
 * Convert everything under `root` to the flat, self-lit look.
 *
 * Works on whatever the exporter produced rather than replacing the material
 * outright, so the map, its colour space, and the skinning setup all survive.
 */
export function flatten(root, opts = {}) {
  const {
    emissive = EMISSIVE,
    roughness = 1.0,
    metalness = 0.0,
    emissiveScale = EMISSIVE_SCALE,
    castShadow = true,
    receiveShadow = true,
    opaque = true,
  } = opts;

  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.castShadow = castShadow;
    o.receiveShadow = receiveShadow;
    // An animated character routinely reaches outside its bind-pose bounds, and
    // three culls on those bounds — without this he blinks out at screen edges.
    if (o.isSkinnedMesh) o.frustumCulled = false;

    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if ('metalness' in m) m.metalness = metalness;
      if ('roughness' in m) m.roughness = roughness;
      if ('envMapIntensity' in m) m.envMapIntensity = 0;

      // ── kill every other way a surface can catch the light ──────────────
      // Exporters happily attach KHR_materials_specular / clearcoat / sheen,
      // and three turns those into a MeshPhysicalMaterial that still glints
      // even at roughness 1. big_donny ships specularColorFactor [2,2,2],
      // which is a deliberate specular BOOST — exactly the wet-plastic sheen
      // this look exists to avoid.
      if ('specularIntensity' in m) m.specularIntensity = 0;
      if (m.specularColor && m.specularColor.setRGB) m.specularColor.setRGB(0, 0, 0);
      if ('clearcoat' in m) m.clearcoat = 0;
      if ('sheen' in m) m.sheen = 0;
      if ('iridescence' in m) m.iridescence = 0;

      // ── opaque, unless the art really needs blending ────────────────────
      // A character exported with alphaMode BLEND depth-sorts against itself:
      // an arm draws over the chest that should occlude it, and it reads as
      // the model glitching. big_donny's texture is fully opaque (alpha is 255
      // everywhere), so the BLEND is an export artefact. Pass opaque:false if a
      // model ever genuinely needs alpha — hair cards, foliage.
      if (opaque && m.transparent) {
        m.transparent = false;
        m.depthWrite = true;
        m.alphaTest = 0;
      }
      // Only set self-illumination up when the MODEL does not already carry it.
      // big_donny ships its own emissiveTexture and emissiveFactor, and
      // overriding those threw away the strength the artist chose and
      // re-derived it from the base map — the same picture, at a level nobody
      // picked. The fallback below stays for models exported with no emissive
      // at all, and for the world geometry built in code.
      const ownEmissive = m.emissiveMap
        && m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.01;
      if (ownEmissive) {
        // Keep the artist's colour and map; only scale the strength.
        m.emissiveIntensity = (m.emissiveIntensity ?? 1) * emissiveScale;
      }
      if ('emissive' in m && !ownEmissive) {
        if (m.map) {
          // Self-illuminate from the texture. White emissive + the map means
          // the emitted colour IS the painted colour, rather than a tint over it.
          m.emissiveMap = m.map;
          m.emissive = new THREE.Color(0xffffff);
          m.emissiveIntensity = emissive;
        } else {
          // Untextured: emit its own flat colour instead, so a prop does not
          // read as dramatically darker than the textured character beside it.
          m.emissive = m.color ? m.color.clone() : new THREE.Color(0xffffff);
          m.emissiveIntensity = emissive * 0.55;
        }
      }
      m.needsUpdate = true;
    }
  });
  return root;
}

/**
 * A flat material for world geometry built in code.
 *
 * Note the emissive default is near zero, unlike the character. Self-lighting
 * the world too washes it out completely: every block goes to the same flat
 * white, the shading that tells you it is a box disappears, and the character
 * stops popping against it. The CHARACTER emits; the world just takes light.
 */
export function flatMaterial({ color = 0xffffff, emissive = 0.05 } = {}) {
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: 1.0,
    metalness: 0.0,
  });
  m.emissive = new THREE.Color(color);
  m.emissiveIntensity = emissive;
  return m;
}

/**
 * Scene lighting. Soft on purpose — the textures carry the brightness, so these
 * only shape the silhouette and cast the ground shadow. Turning these up
 * instead of using the emissive route is what produces a washed-out picture.
 */
export function setupLights(scene, opts = {}) {
  const {
    keyColor = 0xffffff,
    keyIntensity = 1.55,
    ambientColor = 0xdfe8ff,
    ambientIntensity = 0.62,
    hemiSky = 0xe8f2ff,
    hemiGround = 0xb8bcc8,
    hemiIntensity = 0.55,
    shadowExtent = 22,
    shadowMapSize = 2048,
  } = opts;

  const key = new THREE.DirectionalLight(keyColor, keyIntensity);
  key.position.set(9, 16, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 80;
  // Tight, and it follows the player: a wide shadow camera spreads the same
  // texels over the whole level and every shadow turns to mush.
  const s = shadowExtent;
  key.shadow.camera.left = -s;
  key.shadow.camera.right = s;
  key.shadow.camera.top = s;
  key.shadow.camera.bottom = -s;
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.035;
  scene.add(key);
  scene.add(key.target);

  const amb = new THREE.AmbientLight(ambientColor, ambientIntensity);
  scene.add(amb);

  const hemi = new THREE.HemisphereLight(hemiSky, hemiGround, hemiIntensity);
  scene.add(hemi);

  return { key, amb, hemi };
}
