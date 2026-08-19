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
      if (m.emissiveMap && m.emissiveIntensity > 0.1) selfLit++;
      if ((m.metalness ?? 0) > 0.01 || (m.roughness ?? 1) < 0.9) shiny++;
    }
  });
  return {
    height: +size.y.toFixed(3),
    feetY: +box.min.y.toFixed(3),
    clips: c.anim.clips.size,
    missing: c.anim.missing,
    selfLit, shiny, textured,
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
ok('the texture self-illuminates', info.selfLit >= 1, `selfLit=${info.selfLit} textured=${info.textured}`);
ok('nothing on him is shiny', info.shiny === 0, `${info.shiny} material(s) still reflective`);
ok('the takeoff clip never restarts mid-jump', jump.rewinds === 0,
  `${jump.rewinds} rewind(s) — the clip is looping again`);
ok('the jump actually gets high', jump.apex > 2.5, `apex=${jump.apex}m`);
ok('no console errors', errors.length === 0, errors.join(' | '));

console.log(fail ? `\n${fail} failed\n` : '\nsmoke ok\n');
process.exit(fail ? 1 : 0);
