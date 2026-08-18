// Runs the deterministic controller checks, then the browser smoke test.
// The smoke test needs a server on :8123 — `npm start` in another shell.
import { spawnSync } from 'node:child_process';

const steps = ['tests/locomotion.mjs', 'tests/collision.mjs', 'tests/smoke.mjs', 'tests/gestures.mjs'];
let failed = 0;
for (const s of steps) {
  const r = spawnSync(process.execPath, [s], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
