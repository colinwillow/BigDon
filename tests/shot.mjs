import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8123/index.html', { waitUntil: 'load' });
await page.waitForFunction(() => window.character != null, { timeout: 60000 });
await page.waitForTimeout(1500);

// idle
await page.screenshot({ path: 'scratch/01-idle.png' });

// drive him forward: push the character straight through its own API
await page.evaluate(() => {
  window.__drive = { x: 0, z: -1, mag: 1 };
  const c = window.character;
  const orig = c.update.bind(c);
  c.update = (dt) => orig(dt, {
    moveX: window.__drive.x * window.__drive.mag,
    moveZ: window.__drive.z * window.__drive.mag,
    aiming: window.__drive.aiming || false,
    aimYaw: window.__drive.aimYaw || 0,
  });
});
// Recentre the camera behind him before shooting. The camera does NOT swing
// itself around (that is deliberate — see FollowCamera.recentre), so without
// this the shot is taken from whatever angle boot left it at, and a character
// running TOWARD the lens reads at a glance as one running backwards.
await page.waitForTimeout(700);
await page.evaluate(() => window.follow.recentre(window.character));
await page.waitForTimeout(500);
await page.screenshot({ path: 'scratch/02-run.png' });
const st = await page.evaluate(() => ({
  pos: [+character.position.x.toFixed(2), +character.position.z.toFixed(2)],
  speed: +character.speed.toFixed(2),
  facing: +character.facing.toFixed(2),
  state: character.state,
  clips: character.anim.activeList(),
}));
console.log('running:', JSON.stringify(st));

// walk
await page.evaluate(() => { window.__drive.mag = 0.4; });
await page.waitForTimeout(700);
await page.screenshot({ path: 'scratch/03-walk.png' });
console.log('walking:', JSON.stringify(await page.evaluate(() => ({
  speed: +character.speed.toFixed(2), clips: character.anim.activeList(),
}))));

// aim + strafe: face +X while moving -Z
await page.evaluate(() => {
  window.__drive = { x: 0, z: -1, mag: 1, aiming: true, aimYaw: Math.PI / 2 };
});
await page.waitForTimeout(900);
await page.screenshot({ path: 'scratch/04-strafe.png' });
console.log('strafing:', JSON.stringify(await page.evaluate(() => ({
  speed: +character.speed.toFixed(2), facing: +character.facing.toFixed(2),
  clips: character.anim.activeList(),
}))));

// jump
await page.evaluate(() => { window.__drive.aiming = false; character.requestJump(); });
await page.waitForTimeout(260);
await page.screenshot({ path: 'scratch/05-jump.png' });
console.log('air:', JSON.stringify(await page.evaluate(() => ({
  state: character.state, y: +character.position.y.toFixed(2),
  clips: character.anim.activeList(),
}))));

await browser.close();
