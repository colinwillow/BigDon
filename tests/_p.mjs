import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 300, height: 340 } });
await p.goto('http://localhost:8123/index.html', { waitUntil: 'load' });
await p.waitForFunction(() => window.character != null, { timeout: 60000 });
await p.waitForTimeout(800);
await p.evaluate(() => {
  const c = window.character;
  c.update = () => {}; c.anim.update = () => {};
  window.follow.update = () => {};
  const cam = window.follow.camera; cam.position.set(3.6,1.2,0); cam.lookAt(0,0.85,0);
});
for (const [i, f] of [[0,0.0],[1,0.5]]) {
  await p.evaluate((f) => {
    const a = window.character.anim, clip='kick_roundhouse_left';
    for (const [,x] of a.actions) x.setEffectiveWeight(0);
    const act = a.actions.get(clip); act.enabled=true; act.paused=true;
    act.setEffectiveWeight(1); act.time = f * a.duration(clip);
    a.mixer.update(0);
  }, f);
  await p.waitForTimeout(500);
  await p.screenshot({ path: `scratch/px-${i}.png` });
}
await b.close();
