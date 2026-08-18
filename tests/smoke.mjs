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
  let outlines = 0, skinnedOutlines = 0;
  c.model.traverse((o) => {
    if (!o.userData.isOutline) return;
    outlines++;
    if (o.isSkinnedMesh) skinnedOutlines++;
  });
  return {
    height: +size.y.toFixed(3),
    feetY: +box.min.y.toFixed(3),
    clips: c.anim.clips.size,
    missing: c.anim.missing,
    outlines, skinnedOutlines,
  };
});

await page.screenshot({ path: 'scratch/smoke.png' });
await browser.close();

let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log('  ok   ' + name);
  else { fail++; console.log('  FAIL ' + name + (detail ? '  — ' + detail : '')); }
};

console.log('\nsmoke');
ok('all 72 clips loaded', info.clips === 72, `got ${info.clips}`);
ok('clips.js names nothing missing', info.missing.length === 0, info.missing.join(', '));
ok('character is 1.8m tall', Math.abs(info.height - 1.8) < 0.05, `${info.height}m`);
ok('feet sit on the floor', Math.abs(info.feetY) < 0.02, `y=${info.feetY}`);
ok('the skinned ink outline exists', info.skinnedOutlines >= 1, `${info.skinnedOutlines}`);
ok('no console errors', errors.length === 0, errors.join(' | '));

console.log(fail ? `\n${fail} failed\n` : '\nsmoke ok\n');
process.exit(fail ? 1 : 0);
