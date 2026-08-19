# Big Don

A mobile-first twin-stick action game. Runs in the browser, no build
step — `three` is vendored and the browser loads `src/` as written.

```sh
npm start     # http://localhost:8123
npm test
```

## Controls

|            | left stick            | right stick                    |
| ---------- | --------------------- | ------------------------------ |
| **push**   | walk / run            | aim — he turns, camera follows  |
| **flick**  | slide tackle          | melee (alternating-side combo)  |
| **tap**    | recentre the camera   | jump                            |

Push the right stick past the trigger zone and he shoots in that direction.
Ease the left stick out for a walk; push past ~72% for a run.

On a laptop: `WASD` move, `SPACE` jump, `SHIFT` slide, `V` melee, drag to look,
`Q`/`E` turn, `R` recentre.

## Layout

```
index.html          importmap + the touch-control DOM
styles.css
vendor/three/       three r160, vendored — do not replace with a bundler
models/             handyman_game.glb — 54 in-place tracks (the playable one)
src/
  core/math.js      dt-correct damping, angle helpers
  input/
    Joystick.js     the virtual stick + gesture recognition (ported from Peggy)
    Input.js        binds the two sticks to the character's verbs
  player/
    clips.js        which track drives what, plus all the movement tuning
    rig.js          skinned measuring + facing, testable without a GLTF loader
    AnimationController.js   the weighted blend tree
    Character.js    movement + state machine
    loadCharacter.js  load, normalise, toon-ify
  camera/FollowCamera.js
  render/materials.js  flat self-lit materials + lighting
  world/World.js    the white box world
  world/Collider.js AABB collision: walls, platforms, step-up, ceilings
tests/
  locomotion.mjs    51 deterministic controller checks (no browser)
  collision.mjs     16 collision checks (no browser)
  gestures.mjs      real touch events against the sticks
  smoke.mjs         boots the real thing in Chromium
```

See `CLAUDE.md` for the traps this GLB sets and why the input layer is shaped the
way it is.
