import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 640, height: 420 } });
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.goto('http://localhost:8123/index.html', { waitUntil: 'load' });
await p.waitForFunction(() => window.character != null, { timeout: 60000 });
await p.waitForTimeout(700);
await p.evaluate(() => {
  window.__drive = { x: 0, z: 0, mag: 0 };
  const c = window.character, orig = c.update.bind(c);
  c.update = (dt) => orig(dt, { moveX: __drive.x*__drive.mag, moveZ: __drive.z*__drive.mag, aiming:false, aimYaw:0 });
});
// air pose
const air = await p.evaluate(async () => {
  const c = window.character; c.position.set(0,0,0); c.requestJump();
  for (let i=0;i<20;i++) await new Promise(r=>requestAnimationFrame(r));
  const one = { air: c.anim.activeList(2) };
  c.requestJump();   // double
  for (let i=0;i<8;i++) await new Promise(r=>requestAnimationFrame(r));
  const a = c.anim.actions.get('jump_flip');
  return { ...one, flip: c.anim.activeList(2), flipStartT: a ? +a.time.toFixed(3) : -1 };
});
console.log('AIR', JSON.stringify(air));
// cover, both directions
const cov = await p.evaluate(async () => {
  const c = window.character;
  c.position.set(9.5, 0, -8.2); c.facing = 0; c.velocity.set(0,0,0);
  window.__drive = { x: 0, z: 1, mag: 1 };
  for (let i=0;i<80;i++) await new Promise(r=>requestAnimationFrame(r));
  c._tryCover();
  for (let i=0;i<30;i++) await new Promise(r=>requestAnimationFrame(r));
  window.__drive = { x: 1, z: 0, mag: 1 };
  for (let i=0;i<40;i++) await new Promise(r=>requestAnimationFrame(r));
  const right = { facing:+c.facing.toFixed(2), side:c._coverSideHeld, clips:c.anim.activeList(2) };
  window.__drive = { x: -1, z: 0, mag: 1 };
  for (let i=0;i<40;i++) await new Promise(r=>requestAnimationFrame(r));
  const left = { facing:+c.facing.toFixed(2), side:c._coverSideHeld, clips:c.anim.activeList(2) };
  window.__drive.mag = 0;
  for (let i=0;i<30;i++) await new Promise(r=>requestAnimationFrame(r));
  return { right, left, idle: c.anim.activeList(2) };
});
console.log('COVER', JSON.stringify(cov));
await p.screenshot({ path: 'scratch/cover-live.png' });
await b.close();
