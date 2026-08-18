import { chromium } from 'playwright';
const CLIP = process.env.CLIP || 'falling_to_roll';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 260, height: 300 } });
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.goto('http://localhost:8123/index.html', { waitUntil: 'load' });
await p.waitForFunction(() => window.character != null, { timeout: 60000 });
await p.waitForTimeout(600);

await p.evaluate(() => {
  const c = window.character;
  c.update = () => {};                       // freeze the controller
  c.anim.update = () => {};                  // ...and the blender, which would
                                             // otherwise damp our weights to 0
                                             // again on the very next frame
  window.follow.update = () => {};
  const cam = window.follow.camera;
  cam.position.set(4.2, 1.6, 0); cam.lookAt(0, 0.75, 0);   // side-on
  for (const [, a] of c.anim.actions) a.setEffectiveWeight(0);
});
const frames = [];
for (let i = 0; i <= 7; i++) {
  const f = i / 7;
  await p.evaluate(({ clip, f }) => {
    const c = window.character;
    const a = c.anim.actions.get(clip) || c.anim._action(clip);
    for (const [, x] of c.anim.actions) x.setEffectiveWeight(0);
    a.setEffectiveWeight(1); a.enabled = true; a.paused = true;
    a.time = f * c.anim.duration(clip);
    c.anim.mixer.update(0);
  }, { clip: CLIP, f });
  await p.waitForTimeout(120);
  const path = `scratch/clip-${i}.png`;
  await p.screenshot({ path });
  frames.push(path);
}
await b.close();
console.log('frames at t =', [...Array(8)].map((_, i) => (i / 7).toFixed(2)).join(' '));
