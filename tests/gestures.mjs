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

// ── press to crouch, release to jump ───────────────────────────────────────
// This thumb is both the jump and the camera, so the interesting cases are the
// two that must NOT collide: a tap still jumps, and a pan must not leave him
// squatting in the middle of the screen.
const crouch = await page.evaluate(async () => {
  const zone = document.getElementById('zone-right');
  const R = window.__input.right.radius;
  const c = window.character;
  const ox = 600, oy = 380;

  const touch = (type, x, y) => {
    const t = new Touch({ identifier: 9, target: zone, clientX: x, clientY: y,
                          pageX: x, pageY: y });
    const ev = new TouchEvent(type, {
      touches: type === 'touchend' ? [] : [t],
      targetTouches: type === 'touchend' ? [] : [t],
      changedTouches: [t], bubbles: true, cancelable: true,
    });
    (type === 'touchstart' ? zone : window).dispatchEvent(ev);
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  // Everything below is stepped in FRAMES, not milliseconds. The arming window
  // is wall-clock (CROUCH_ARM_MS), but the state it produces is only visible
  // once Input.sample() has run, and sample() rides the render loop — which in
  // a software-rendered headless Chromium is somewhere between 10 and 30fps.
  // Sleeping a fixed 120ms and asking "is he crouching yet" is therefore a coin
  // flip on the machine, not on the code.
  const raf = () => new Promise(r => requestAnimationFrame(r));
  const settle = async () => {
    // Back on the ground, standing, before the next scenario.
    for (let i = 0; i < 400 && !(c.grounded && c.state === 'ground'); i++) {
      await raf();
    }
    // ...and past the flick mute a previous scenario may have left behind,
    // which only delays the crouch arming but would skew the timings here.
    for (let i = 0; i < 60 && window.__input.right.muted; i++) await wait(16);
    await raf(); await raf();
  };

  await settle();

  // ── a tap ───────────────────────────────────────────────────────────
  // The property being pinned is that the crouch arms within a handful of
  // frames of the thumb landing, with the thumb never leaving the origin.
  const preTap = c.state + '/' + c.grounded;
  touch('touchstart', ox, oy);
  let tapFrames = 0;
  while (c.state !== 'crouch' && tapFrames < 8) { await raf(); tapFrames++; }
  const tapCrouched = c.state === 'crouch';
  touch('touchend', ox, oy);
  await raf(); await raf();
  const tapJumped = c.velocity.y > 0 || c.position.y > 0.2;
  await settle();

  // ── a hold, thumb parked at the origin ──────────────────────────────
  touch('touchstart', ox, oy);
  await wait(400);
  const heldCrouch = c.state === 'crouch';
  touch('touchend', ox, oy);
  await raf(); await raf();
  const heldJumped = c.velocity.y > 0 || c.position.y > 0.2;
  await settle();

  // ── a camera pan: press, then drag straight out ─────────────────────
  // Sampled every frame, because "he crouched for three frames" is exactly the
  // failure this is here to catch and a single check after the fact misses it.
  // Touch events are NOT gated by the render loop — a real thumb keeps sending
  // moves at 60-120Hz however slowly the frame is drawing — so the moves go out
  // on a timer while the state is sampled on frames. Driving one move per frame
  // instead models a thumb that stops dead whenever the GPU stalls, which is
  // not a thumb.
  touch('touchstart', ox, oy);
  let panCrouched = false;
  let step = 0;
  const pan = setInterval(() => {
    step++;
    if (step <= 12) touch('touchmove', ox + R * 0.10 * step, oy);
  }, 16);
  for (let i = 0; i < 20; i++) {
    await raf();
    if (c.state === 'crouch') panCrouched = true;
  }
  clearInterval(pan);
  touch('touchend', ox + R * 1.1, oy);
  await raf(); await raf();
  const panJumped = c.velocity.y > 0 || c.position.y > 0.2;

  return { preTap, tapFrames, tapCrouched, tapJumped,
           heldCrouch, heldJumped, panCrouched, panJumped };
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

ok('a tap crouches within a few frames of the press', crouch.tapCrouched,
  `pre=${crouch.preTap} after ${crouch.tapFrames} frame(s)`);
ok('and jumps on the way up', crouch.tapJumped);
ok('a held press stays crouched', crouch.heldCrouch);
ok('and still jumps when released', crouch.heldJumped);
ok('a camera pan never crouches, not even for a frame', !crouch.panCrouched);
ok('and a pan does not jump when the thumb lifts', !crouch.panJumped);

console.log(fail ? `\n${fail} failed\n` : '\ngestures ok\n');
process.exit(fail ? 1 : 0);
