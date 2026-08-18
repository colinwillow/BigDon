# Working on Big Don

A mobile-first, toon-shaded twin-stick action game. Two thumbs, no buttons.

## Anything meant for testing goes to `main`

**Always push to `main`.** GitHub Pages serves `main`, and a change that Pages
isn't serving cannot be played on a phone — which is the only place this game is
really tested.

So: branch as much as you like while working. What does not work is *ending* a
requested change on a branch. "It's done, it's on `claude/whatever`" means it
can't be played, so it isn't done. Merge to `main` and push before reporting
back. If a change turns out bad it gets reverted; that's cheap, and cheaper than
a review step nobody performs.

Don't open a pull request unless asked — it's an extra click between the work and
the phone it needs to run on.

## No build step — keep it that way

`three` is vendored into `vendor/three/`, `index.html` has an importmap, and the
browser loads `src/*.js` exactly as written. So the loop is: **edit, push,
play**. GitHub Pages serves the repo directly.

Adding Vite/TypeScript/a bundler breaks that loop — a change would sit in source
while the phone keeps running a stale `dist/`. Don't. If you want type-checking,
JSDoc gets you most of it in an editor for free.

Two consequences worth knowing:

* `src/` imports three by **relative path** (`../../vendor/three/three.module.js`),
  not the bare specifier `three`. That is what lets `tests/locomotion.mjs` import
  the controller straight into node with no import map. The importmap in
  `index.html` exists for the vendored *addons*, which import `'three'`
  internally.
* Anything added to `vendor/three/addons/` must have its own transitive imports
  vendored too. `GLTFLoader` needs `utils/BufferGeometryUtils.js`; a missing one
  is a 404 at boot and a blank screen.

## Test before you push

```sh
npm start            # static server on :8123
node tests/locomotion.mjs   # 31 controller checks, no browser needed
node tests/smoke.mjs        # boots the real game in Chromium
npm test                    # both
```

`tests/locomotion.mjs` steps `Character` at a fixed dt with a stub model, so the
numbers don't depend on the renderer, the GPU, or the GLB.

**When you add a check, ask what it would still pass with.** A suite that only
measures distance passes happily while movement runs backwards. Several checks
in there exist purely to pin down *direction* and handedness — the aim-mode
strafe check would pass with the left and right clips swapped if it only
asserted "some strafe clip is playing".

## The look, and where the numbers come from

**Robits is the reference, not Peggy.** Peggy's input layer got ported in first
because it was already split into modules and its header credited Robits — but
Peggy's flick detector is a *different algorithm* from Robits', and none of
Peggy's movement or render numbers came from Robits at all. Robits is the game
that had months of tuning; when something needs a number, go and read it out of
`index.html` there rather than inventing one.

Robits normalises its player to **18 world units**, and Big Don is 1.8m, so
**10 Robits units = 1 metre** and its constants convert straight across. What is
already taken: the 1.55 run multiplier, `_RUN_DEAD` 0.45 (run threshold), 32
m/s^2 gravity, and a fast velocity ramp. See the block comment on `TUNING` in
`src/player/clips.js`.

Still NOT ported: the flick detector itself. Robits resolves a flick by
snap-out-and-return (out past 0.78, back inside 0.40, within 160ms); the
`Joystick.js` here uses Peggy's radial-speed-plus-rebound model instead.

### Rendering: the texture lights itself

There is no toon shader and no ink outline — the model's own texture maps are
already stylised, so shading them again just fought them. The look is Robits':

* the base colour map is fed back in as an **emissive map** at ~0.9, so the
  character is lit by his own paint and reads at full saturation
* `metalness 0, roughness 1` — a GLB arrives with mid PBR values, and that
  moving specular hotspot is what made a hand-painted texture look like wet
  plastic
* **ACES tone mapping at exposure 1.1**. Counter-intuitive with an emissive
  texture, but `NoToneMapping` clips every bright pixel to flat white

The world does NOT self-illuminate — only the character. Emissive on the world
too washes every block to the same flat white and the character stops popping.

## The model

### Two traps this GLB sets

Both of these cost real debugging time; they are documented at the call sites.

1. **`Box3.setFromObject` lies about skinned meshes.** It measures the geometry's
   bind-pose box through the mesh node's `matrixWorld`, but a skinned mesh's
   vertices are placed by the *bones* — the node transform doesn't move them.
   This file carries the exporter's 0.01 armature scale on the mesh node, so
   `setFromObject` reports a 0.36m character that renders 4.5m tall. Use
   `skinnedBounds()` in `loadCharacter.js`.

2. **`updateWorldMatrix` is not `updateMatrixWorld`.** Different methods.
   `SkinnedMesh` overrides only the latter, and that override is what recomputes
   `bindMatrixInverse`. Call the wrong one before measuring and every skinned
   vertex goes through a stale inverse — the measurement came out 150x wrong,
   which then read as "the camera is broken" and "the outline is missing".

Because of these, `normaliseHeight()` runs *after* the first `anim.update()`, so
it measures what is actually on screen.

## Handedness: derive it, never guess it

Two bugs shipped here at once and hid each other, which is the thing to watch
for. The model was rotated half a turn (`measureYawOffset` used `right x up`
where forward is `up x right`), and the blend tree's left and right strafes were
swapped. Each one alone is obvious; together the strafes looked *fine* and only
running forwards looked wrong, so the report was "he moonwalks" and the strafe
bug was invisible.

The fix for both is the same discipline — check the handedness against three's
own camera basis rather than intuition:

* Its right is `+X`, its up is `+Y`, and it looks down `-Z`.
* So `up x right = (0,1,0) x (1,0,0) = (0,0,-1)` — that is forward.
* `right x up` gives `+Z`, the exact negation.

And for the strafe mapping: put a camera at `(0,0,5)` looking at the origin, and
world `+X` lands on the right of the screen. A character facing `+Z` faces that
camera, so **his** right hand is at world `-X` — the mirror. His right is local
`-X`, which is local angle `-PI/2`.

`tests/locomotion.mjs` now pins both directions of every axis, and
`src/player/rig.js` is split out of `loadCharacter.js` purely so the orientation
maths can be tested headlessly against a synthetic rig — `loadCharacter.js`
imports `GLTFLoader`, which imports the bare specifier `three` and cannot be
loaded into node.

## Input is ported, not invented

`src/input/Joystick.js` came from Peggy, which got it from Robits, and it is the
way it is because of play-testing rather than design. Read the comment block at
the top before changing a threshold. The parts that look redundant and are not:

* **Floating origin** — the stick centres wherever the thumb lands. You never
  look at your thumbs on a phone.
* **The flick peak latch** — a flick can peak and return between two frames at
  30fps, and a per-frame sample misses it entirely.
* **Flick as a *candidate*** — a fast pan and a flick are both fast, so the flick
  can't fire on crossing a threshold. It resolves on what happens next: snapped
  back or released → flick; still travelling after 200ms → it was a pan. Camera
  deltas are buffered meanwhile so a melee never whips the view.

The camera pans on thumb *movement*, not held deflection. That is what frees the
out-and-still posture to mean "aiming", which is what makes hold-to-shoot work.

## The bar for "done"

It runs on a phone, in portrait and in landscape, with two thumbs. Not "it works
if you also have a keyboard" — WASD exists so this is debuggable on a laptop, and
that is all it is for.
