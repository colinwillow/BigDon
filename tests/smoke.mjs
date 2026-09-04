// Render smoke test: boot the real game in a real browser, fail on any console
// error, and assert the things that only break once WebGL is involved —
// the model loading, the skinned-outline shader compiling, and the character
// ending up the size he is supposed to be.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:8123/index.html';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.character != null, { timeout: 60000 });
await page.waitForTimeout(1000);

const info = await page.evaluate(() => {
  const THREE = window.THREE;
  const c = window.character;
  const box = new THREE.Box3().setFromObject(c.model);
  const size = new THREE.Vector3(); box.getSize(size);
  // The look is carried by the material, so check THAT rather than counting
  // outline meshes: the texture must be feeding its own emissive, and nothing
  // may be shiny (a stray metalness is what puts a moving hotspot on him).
  let selfLit = 0, shiny = 0, textured = 0;
  c.model.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.map) textured++;
      if (m.emissiveMap) selfLit++;
      if ((m.metalness ?? 0) > 0.01 || (m.roughness ?? 1) < 0.9) shiny++;
    }
  });
  return {
    height: +size.y.toFixed(3),
    feetY: +box.min.y.toFixed(3),
    clips: c.anim.clips.size,
    missing: c.anim.missing,
    selfLit, shiny, textured,
    trimmed: c.anim.trimmed.length,
    deRooted: c.anim.deRooted.length,
    // The worst offender in the pack, and the one the slide tackle plays.
    slideDrift: (() => {
      const t = c.anim.clips.get('run_slide').tracks
        .find(t => /Hips\.position$/.test(t.name));
      if (!t) return -1;
      const n = t.times.length, v = t.values;
      return +Math.hypot(v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 2] - v[2]).toFixed(3);
    })(),
    runDur: +c.anim.duration('run_fast_forward').toFixed(4),
  };
});

// ── the jump must not restart its takeoff clip ────────────────────────────
// jumping_up is 0.27s and every tree action is created LoopRepeat by default,
// so it used to restart three or four times per ascent — which is exactly what
// "it plays the first few frames over and over" looks like. Sample the playhead
// through a whole jump and assert it never rewinds.
const jump = await page.evaluate(async () => {
  const c = window.character;
  c.position.set(0, 0, 0); c.velocity.set(0, 0, 0);
  c.requestJump();
  const samples = [];
  const name = c.anim.constructor.name && 'jumping_up';
  for (let i = 0; i < 90; i++) {
    await new Promise(r => requestAnimationFrame(r));
    const a = c.anim.actions.get('jumping_up');
    samples.push({ t: a ? +a.time.toFixed(4) : -1, y: +c.position.y.toFixed(3), st: c.state });
  }
  let rewinds = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].t < samples[i - 1].t - 1e-6) rewinds++;
  }
  return { rewinds, apex: Math.max(...samples.map(s => s.y)), maxT: Math.max(...samples.map(s => s.t)) };
});

await page.screenshot({ path: 'scratch/smoke.png' });
await browser.close();

let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log('  ok   ' + name);
  else { fail++; console.log('  FAIL ' + name + (detail ? '  — ' + detail : '')); }
};

console.log('\nsmoke');
ok('every clip loaded (54 + derived)', info.clips >= 54, `got ${info.clips}`);
ok('clips.js names nothing missing', info.missing.length === 0, info.missing.join(', '));
ok('character is 1.8m tall', Math.abs(info.height - 1.8) < 0.05, `${info.height}m`);
ok('feet sit on the floor', Math.abs(info.feetY) < 0.02, `y=${info.feetY}`);
// Checks the emissive map is BOUND, not that it is above some strength — the
// strength is a look decision (EMISSIVE_SCALE) and may legitimately be 0.
ok('an emissive map is bound', info.selfLit >= 1, `selfLit=${info.selfLit} textured=${info.textured}`);
ok('nothing on him is shiny', info.shiny === 0, `${info.shiny} material(s) still reflective`);
ok('the takeoff clip never restarts mid-jump', jump.rewinds === 0,
  `${jump.rewinds} rewind(s) — the clip is looping again`);
ok('the jump actually gets high', jump.apex > 2.5, `apex=${jump.apex}m`);
ok('duplicated loop frames were trimmed', info.trimmed > 0,
  `${info.trimmed} clip(s) trimmed`);
// The pack advertises itself as in-place and its cycles are, but the one-shots
// travel — run_slide most of all. Left in, the mesh slides ahead of where he
// actually is and snaps back when the clip lets go.
ok('baked travel was stripped out of the one-shots', info.deRooted > 0,
  `${info.deRooted} clip(s) de-rooted`);
ok('the slide tackle no longer carries its own 2.5m', info.slideDrift < 0.01,
  `run_slide hips travel ${info.slideDrift} units`);
// 14 keys at 24fps authored to 0.5833s; minus the duplicate that is 0.5417s.
ok('the sprint cycle lost exactly one frame',
  Math.abs(info.runDur - (0.5833 - 1 / 24)) < 0.002, `run_fast_forward=${info.runDur}s`);
ok('no console errors', errors.length === 0, errors.join(' | '));

console.log(fail ? `\n${fail} failed\n` : '\nsmoke ok\n');
process.exit(fail ? 1 : 0);
