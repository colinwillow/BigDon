// Boot, main loop, and the debug HUD.

import * as THREE from '../vendor/three/three.module.js';
import { setupLights } from './render/materials.js';
import { buildWorld } from './world/World.js';
import { loadCharacter, normaliseHeight } from './player/loadCharacter.js';
import { Character } from './player/Character.js';
import { FollowCamera } from './camera/FollowCamera.js';
import { Input } from './input/Input.js';
import { TUNING } from './player/clips.js';

/** The playable character. */
const MODEL = 'models/big_donny.glb';
import { clamp } from './core/math.js';

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// ACES, not NoToneMapping. With the textures self-illuminating, NoToneMapping
// clips every bright pixel to flat white and the highlights lose their detail;
// ACES rolls them off instead. This is most of why Robits reads as graded and
// crisp rather than blown out.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 200);

const lights = setupLights(scene);
const { collider } = buildWorld(scene);

const follow = new FollowCamera(camera);

let character = null;
let input = null;
let running = false;

const hud = {
  state: document.getElementById('hud-state'),
  speed: document.getElementById('hud-speed'),
  fps: document.getElementById('hud-fps'),
  gesture: document.getElementById('hud-gesture'),
  clips: document.getElementById('hud-clips'),
};

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (input) input.layout();
}
window.addEventListener('resize', resize);
// iOS fires orientationchange before the new innerWidth/Height are readable.
window.addEventListener('orientationchange', () => setTimeout(resize, 120));

async function boot() {
  const loaded = await loadCharacter(MODEL);
  scene.add(loaded.root);

  character = new Character(loaded.root, loaded.clips, collider);

  // Tick the animation once so the skeleton is genuinely posed, THEN scale him
  // to 1.8m and sit him on the floor. See normaliseHeight() for why the
  // measurement is worthless before this point.
  character.anim.locomotion(0, 0, 0);
  character.anim.update(1 / 60);
  const appliedScale = normaliseHeight(loaded.root);
  console.log('[bigdon] scaled x' + appliedScale.toFixed(3));
  window.character = character;   // console access while tuning
  window.THREE = THREE;
  window.follow = follow;
  window.scene = scene;

  if (character.anim.missing.length) {
    console.warn('clips.js names tracks that are not in the GLB:', character.anim.missing);
  }
  // A model whose clips have no keyframes stands in its bind pose while
  // everything else looks fine, so say so loudly rather than letting it look
  // like a bug in the blend tree.
  if (character.anim.flat.length) {
    console.warn(
      `[bigdon] ${character.anim.flat.length} clip(s) in ${MODEL} have no animation data ` +
      `— they will hold the bind pose. Re-export with the animation baked. ` +
      `First few: ${character.anim.flat.slice(0, 5).join(', ')}`
    );
  }

  input = new Input({
    zoneLeft: document.getElementById('zone-left'),
    zoneRight: document.getElementById('zone-right'),
    knobLeft: document.getElementById('knob-left'),
    ringLeft: document.getElementById('ring-left'),
    knobRight: document.getElementById('knob-right'),
    ringRight: document.getElementById('ring-right'),
  }, follow);

  input.onJump = () => character.requestJump();
  // Right-stick flick: a slide tackle if he is already running, a strike
  // otherwise. Flicking the LEFT stick while also steering with it is awkward,
  // so the slide lives on the free thumb — and at speed the tackle is the move
  // you want anyway.
  input.onMelee = (a) => {
    const angle = a ?? character.facing;
    if (character.grounded && character.speed >= TUNING.slideFromRunAt) {
      if (character.requestSlide(angle)) return;
    }
    character.requestMelee(angle);
  };
  input.onSlide = (a) => character.requestSlide(a);
  input.onRecentre = () => follow.recentre(character);

  window.__input = input;         // gesture tests drive the sticks through this

  input.layout();
  follow.snapTo(character);
  resize();

  document.getElementById('boot').classList.add('hidden');
  running = true;
}

// ── loop ────────────────────────────────────────────────────────────────────
let last = performance.now();
let fpsAccum = 0, fpsFrames = 0, fpsShown = 0;

function frame(now) {
  requestAnimationFrame(frame);
  // Clamped so a tab-switch or a GC pause cannot teleport the character across
  // the map on the frame it resumes.
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (!running) return;

  input.sample();

  // Pressing into a wall on the ground slips him into cover. Polled rather than
  // bound to a button, and deliberately cheap to trigger — cover is magnetic on
  // the way in and sticky on the way out.
  if (character.state === 'ground'
      && input.moveMag > TUNING.coverEnterPush
      && character.speed < TUNING.coverEnterSpeed) {
    character._tryCover();
  }

  character.update(dt, {
    moveX: input.move.x * input.moveMag,
    moveZ: input.move.z * input.moveMag,
    aiming: input.aiming,
    // He faces where the CAMERA is looking, not where the stick points. The
    // stick now drives the camera's turn rate, so taking his facing from the
    // camera makes him turn at exactly that rate too, instead of snapping to a
    // stick direction the camera then had to chase.
    aimYaw: follow.yaw + Math.PI,
  });
  character.anim.update(dt);

  // The stick steers the camera directly now, so there is nothing to attract
  // it toward — attract() existed to chase an absolute stick direction.
  if (input.aiming) follow.aimHold();
  follow.update(dt, character, { x: input.lookX, dxPx: input.lookDx });

  // Keep the shadow camera on the character, so its 2048 texels stay where
  // they are being looked at.
  lights.key.position.set(
    character.position.x + 9, 14, character.position.z + 6
  );
  lights.key.target.position.copy(character.position);
  lights.key.target.updateMatrixWorld();

  renderer.render(scene, camera);

  // ── hud ────────────────────────────────────────────────────────────────
  fpsAccum += dt; fpsFrames++;
  if (fpsAccum >= 0.4) {
    fpsShown = Math.round(fpsFrames / fpsAccum);
    fpsAccum = 0; fpsFrames = 0;
  }
  hud.state.textContent = character.state + (character.aiming ? ' · aim' : '');
  hud.speed.textContent = character.speed.toFixed(1) + ' m/s';
  hud.fps.textContent = fpsShown + ' fps';
  hud.gesture.textContent =
    (input.left.lastGesture || '—') + ' / ' + (input.right.lastGesture || '—');
  hud.clips.textContent = character.anim.activeList().join('  ');
}

requestAnimationFrame(frame);
boot().catch((e) => {
  console.error(e);
  document.querySelector('#boot p').textContent = 'failed to load: ' + e.message;
});
