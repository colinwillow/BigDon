// Gesture checks driven by real touch events in a real browser.
//
// The joystick can only be tested this way: its whole job is interpreting a
// stream of touchmoves against wall-clock time, and the bug these exist to
// catch (one flick per touch) is invisible to anything that calls the
// controller directly.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:8123/index.html';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 }, hasTouch: true });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.character != null, { timeout: 60000 });
await page.waitForTimeout(600);

// Drive the right stick by hand. Coordinates are relative to the touch origin,
// in fractions of the stick radius.
const result = await page.evaluate(async () => {
  const stick = window.__input.right;
  const zone = document.getElementById('zone-right');
  const R = stick.radius;
  const ox = 600, oy = 380;

  let flicks = 0;
  const prevFlick = stick.onFlick;
  stick.onFlick = () => { flicks++; };

  const touch = (type, x, y, target) => {
    const t = new Touch({ identifier: 7, target, clientX: x, clientY: y, pageX: x, pageY: y });
    const ev = new TouchEvent(type, {
      touches: type === 'touchend' ? [] : [t],
      targetTouches: type === 'touchend' ? [] : [t],
      changedTouches: [t], bubbles: true, cancelable: true,
    });
    (type === 'touchstart' ? target : window).dispatchEvent(ev);
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // ── one continuous touch, two flicks, never lifting ────────────────────
  touch('touchstart', ox, oy, zone);
  await wait(20);
  // snap out fast (arms the candidate)
  touch('touchmove', ox + R * 0.35, oy, zone); await wait(12);
  touch('touchmove', ox + R * 0.95, oy, zone); await wait(12);
  // rebound toward centre -> flick 1 fires
  touch('touchmove', ox + R * 0.55, oy, zone); await wait(12);
  // fall back inside FLICK_RESET so the next flick can arm
  touch('touchmove', ox + R * 0.10, oy, zone); await wait(40);
  const afterFirst = flicks;

  // second flick, SAME touch, no lift
  touch('touchmove', ox + R * 0.35, oy, zone); await wait(12);
  touch('touchmove', ox + R * 0.95, oy, zone); await wait(12);
  touch('touchmove', ox + R * 0.55, oy, zone); await wait(12);
  const afterSecond = flicks;
  touch('touchend', ox + R * 0.55, oy, zone);
  await wait(30);

  stick.onFlick = prevFlick;
  return { afterFirst, afterSecond };
});

await browser.close();

let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log('  ok   ' + name);
  else { fail++; console.log('  FAIL ' + name + (detail ? '  — ' + detail : '')); }
};

console.log('\ngestures');
ok('a flick fires', result.afterFirst >= 1, `${result.afterFirst}`);
ok('a SECOND flick fires in the same touch, without lifting',
  result.afterSecond >= 2,
  `${result.afterSecond} flick(s) — one flick per touch means melee cannot combo`);

console.log(fail ? `\n${fail} failed\n` : '\ngestures ok\n');
process.exit(fail ? 1 : 0);
