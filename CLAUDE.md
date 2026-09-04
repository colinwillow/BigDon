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
node tests/locomotion.mjs   # 106 controller checks, no browser needed
node tests/collision.mjs    # 53 collision checks, no browser needed
node tests/smoke.mjs        # boots the real game in Chromium
node tests/gestures.mjs     # drives the sticks with real touch events
npm test                    # all three

CLIP=standing_melee_attack_backhand node tests/clipstrip.mjs   # audition any clip
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

* the character is lit by his own paint, so his colours read at full saturation.
  `EMISSIVE_SCALE` in `render/materials.js` multiplies whatever the model ships;
  at big_donny's authored 0.6 his hair washes to near-white, so it runs at half
  of that (about 0.3 effective). Set it to 0 to kill self-illumination entirely
  — the form reads best there, at the cost of vibrancy.
  `big_donny.glb` ships this itself — an `emissiveTexture` plus an
  `emissiveFactor` of 0.6 — and `flatten()` LEAVES A MODEL'S OWN EMISSIVE ALONE.
  It only feeds the base colour map back in as an emissive map (at `EMISSIVE`,
  0.92) when the model arrives with none, which covers older exports and the
  world geometry built in code. Overriding an artist-set emissive throws away
  the strength they chose and re-derives it at a level nobody picked.
* `metalness 0, roughness 1`, and `specularIntensity`/clearcoat/sheen zeroed —
  a GLB arrives with mid PBR values and often a `KHR_materials_specular` boost
  (big_donny's is 2.0), and that moving specular hotspot is what made a
  hand-painted texture look like wet plastic. This part is still forced.
* **ACES tone mapping at exposure 1.1**. Counter-intuitive with an emissive
  texture, but `NoToneMapping` clips every bright pixel to flat white

The world does NOT self-illuminate — only the character. Emissive on the world
too washes every block to the same flat white and the character stops popping.

## The model

`models/big_donny.glb` is the playable character (set in `src/main.js`).
`handyman_game.glb` and `donny_game.glb` are kept in the repo but not loaded.

The loader handles Draco compression (`big_donny.glb` lists
`KHR_draco_mesh_compression` in `extensionsRequired`, and without the decoder the
load fails outright), and drops Blender's `.001` duplicate actions — re-importing
an animation set leaves a second copy of every clip, so big_donny ships 110 that
are really 54.

54 clips, Mixamo rig (`mixamorig_*`, 65 joints), all IN-PLACE — no track
translates the character, so code owns movement and the clip owns the pose.

The exporter names every track `Armature|<name>|Layer0`; `loadCharacter` strips
that once at load so `clips.js` can use the bare names.

### What the pack does and does not have

Complete: forward walk/run (three gaits), both strafes, full hang/ledge set
(idle, shimmy, hop, climb-up, jump-to-hang), full cover set (in, idle, sneak,
out — both sides), crouch idle + crouch strafes, a slide, and 15 mirrored
left/right strike pairs.

Missing, and worth knowing before you look for a bug:

* **No backward walk or run.** `DERIVED` in `clips.js` builds one by cloning the
  forward gait and scrubbing its phase backwards, which reads convincingly
  because it is literally the forward cycle running in reverse.
* **No turn-in-place**, and **no crouch forward walk** (only crouch strafes).

### Strikes are mirrored, and the side alternates

Every strike ships `_left` and `_right`. `MELEE_COMBO` lists unsided base names
and `Character` appends the side, ALTERNATING down the chain from a random
start. Re-rolling the side at random instead throws the same hand twice in a row
often enough to read as a hitch.



### A clip list can lie

`big_donny.glb` first shipped with all 54 clip names, correct durations, and no
keyframes — every bone but the head was a two-key constant. The actions played,
reported sensible weights, and the character stood in his bind pose. Every check
short of looking at the screen passed. The re-export fixed it, but two clips
(`kick_spinning_hurricane_left` / `_right`) are still empty, and were empty in
handyman too — so the combo finisher is `kick_spin` instead.

`_findFlatClips` now catches it at load and warns: a clip that is nearly all
two-key tracks is holding one pose, and real locomotion runs 20-50 animated
tracks. When a new model looks frozen, check the console before the blend tree.

To compare two exports directly, count animated tracks per clip:

```py
sum(1 for ch in anim['channels']
    if accessors[anim['samplers'][ch['sampler']]['input']]['count'] > 2)
```

### "In-place" is true of the cycles and false of the one-shots

The pack advertises itself as in-place and the locomotion genuinely is — every
walk and run measures a net hips displacement of **0.00**. The ONE-SHOTS are
not. Measured on `big_donny.glb`, at roughly 1 unit per centimetre:

```
run_slide 255 · swimming 83 · kick_spin 67 · stand_to_cover 45
cover_to_stand 38 · jump_to_hang 37 · hang_to_climb_up 25 · landing 5
```

Code owns movement here, so that travel is not motion, it is a lie: the mesh
slides forward of where the character actually is and snaps back the instant
the clip stops driving him. **That snap is what reads as "he teleports back to
where he was" after a slide tackle**, and no amount of procedural lunge fixes
it — the two are fighting rather than adding. It is easy to misdiagnose as a
missing lunge, because the character is genuinely moving the whole time.

`_stripRootMotion` in `AnimationController` handles it at load, per clip and
binary: a clip whose hips END somewhere else horizontally has that channel
PINNED to its first key; a clip that ends where it began is not touched at all.
That split falls exactly along one-shots vs cycles, which is the split that
matters — sway and travel are the same channel and cannot be separated within a
clip, but a cycle has no travel to remove and a one-shot's sway is subordinate
to not detaching from where he is.

**Subtracting only the linear ramp does not work**, and it is the obvious first
try. `run_slide`'s travel eases out rather than running linear, and the slide
plays barely half the clip, so the residual still measured **0.66m** of drift
mid-tackle — the same bug, three quarters smaller. To check a change here,
measure the hips bone's world position against `character.position` through the
move; it should stay inside about 7cm, which is ordinary hip sway.

Y is left alone: vertical hip travel is pose (the crouch dip, the climb) in a
way horizontal travel is not.

### Rigs are not interchangeable

handyman and big_donny share 57 `mixamorig_*` bone names, which makes clip reuse
look trivial. It is not: their rest translations differ on 46 of those 57 bones,
and handyman bakes a -90 degree X rotation into `mixamorig_Hips` while big_donny
moves it to a new `root` bone above the hips. Animation channels store ABSOLUTE
local transforms, so replaying one rig's tracks on the other double-rotates him.
Matching bone names are not a matching rig.

### Two traps these GLBs set

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

## Collision

`src/world/Collider.js`. Everything solid is an axis-aligned box, so this is
exact — no physics engine, no broadphase. The player is a vertical CYLINDER
(circle in XZ plus a height); a capsule would only matter on slopes and there
are none.

Three things carry the feel, and all three have a test:

* **Step-up.** Anything within `stepHeight` (0.42m) is walked onto rather than
  collided with. A kerb you have to jump over is infuriating.
* **Swept ground.** He jumps 4m and falls at 32 m/s^2, so a long frame covers
  most of a metre. `groundAt` takes the whole span he moved through — testing
  only the final position drops him through platforms.
* **Axis-of-least-penetration push-out.** Pushing along the vector to the box's
  closest point flicks him diagonally around corners; resolving along the
  shallowest axis slides him along the wall.

The world registers its own geometry (`buildWorld` returns `{group, collider}`),
so the visual and collision worlds cannot drift apart. `Character` takes the
collider as an optional third argument — without one the world is a flat plane
at y=0, which is what the headless controller tests run against.

## Ledges and cover

Both are *suspended* states: `hang`, `climb` and `cover` own their own position
outright and skip gravity, the world sweep and the ground query entirely. A hang
that is still subject to gravity slides a few centimetres a frame, which reads
as the grab not holding.

`Collider.findLedge` and `findWall` probe forward from the character and return
the face position, its outward normal, and how far the edge runs — which is what
lets shimmying and cover-sneaking clamp to the actual extent of the box.

**Movement along a surface is the plain tangent component, never multiplied by
the normal's sign.** Doing that inverts it on walls facing the other way, so
shimmying went the wrong direction depending on which face of a block you were
on. The sided CLIP is a separate question, answered by which of his own
shoulders he is moving toward, so it stays right on every face. See
`_alongSurface`.

The grab is POLLED every airborne frame rather than bound to a button — missing
a ledge should be the level's fault, not the player's.

### The verb map, after the second tuning pass

* **Right-stick flick** is a SLIDE TACKLE when already running (`slideFromRunAt`),
  a strike otherwise. Flicking the left stick while also steering with it is
  awkward, so the slide moved to the free thumb.
* **Jump** is the only way up a ledge. Pushing into the wall used to climb, which
  meant shimmying at a slight angle launched him onto the top by accident.
* **Jump from cover** launches him up the wall, which is the route from pressed
  against it to hanging off its top.
* **Double jump**: one air jump, playing `jump_flip`, weaker than the first so
  the first jump stays a decision.
* **The jump is a press and a release, not a tap.** The thumb going down
  crouches him; the thumb coming up launches him. A tap is the same motion too
  quick to see much of, which is where the jump's anticipation comes from — and
  is why there is no stand-to-jump clip and none is needed.
* **EVERY grounded jump goes through the crouch, tap included.** A thumb can
  come and go faster than the stick arms a crouch, so `releaseCrouch` takes one
  itself if there isn't one; and a crouch younger than `crouchMinTime` (0.11s)
  does not launch, it ARMS, and `_update` fires it once the pose has had time to
  read against `blendHL`. Launching on the release meant a tap showed no crouch
  at all, which is the whole reason the jump moved onto a press and a release.
* **Held, the crouch is a slide, and it feeds a LONG JUMP** — the Mario move.
  Momentum carries and bleeds off against `crouchFriction`; release above
  `longJumpAt` and the launch goes flatter (`longJumpSpeed`, below the normal
  `jumpSpeed`) and much faster along the ground (`longJumpBoost`). Boosting the
  ground speed without lowering the launch just makes a longer normal jump.

### The jump thumb is also the camera

That collision is the whole difficulty of press-to-crouch, and it is resolved
in `Input.js` by two SEPARATE guards — one on time, one on deflection:

* `CROUCH_ARM_MS` (70ms) — the thumb must be down AND PARKED for a beat,
  measured off the stick's stillness clock (`Joystick.stillMs`), not off the
  press. A pan's thumb is moving, so that clock keeps resetting and the crouch
  never arms at all. Timing it from the press instead worked at 60fps and
  blipped a crouch on the way out at 24, because a slow frame lets the window
  elapse before the deflection guard has seen anything move.
* `CROUCH_MAX_PUSH` (0.35) — any deflection past this, at any time, and the
  touch was a look or an aim: the crouch is abandoned and the release does not
  jump. Deliberately below the stick's own `TAP_MAX_PUSH`.

Three things there are easy to get wrong:

* **Whether the release jumps depends on whether the TOUCH was a crouch
  candidate, not on whether he actually crouched.** Pressing in mid-air never
  crouches but must still fire the double jump.
* **The release re-checks `lastGesture` and `peakPush`.** A flick can snap out
  and let go inside one frame, so `sample()` may never have seen the deflection
  that should have cancelled the crouch — the same reason the flick peak is
  latched at all.
* **The flick mute only DELAYS the arm; it must not kill the touch.** The flick
  itself already aborts the crouch. Treating the leftover 260ms mute from a
  previous melee as an abort meant the next press could not jump at all for a
  quarter of a second after every swipe. `tests/gestures.mjs` pins the tap, the
  hold and the pan.

### Melee: turn into the flick, and keep the blend worth one pose

Two separate things made a flicked strike read as choppy, and they compounded.

* **`requestMelee` assigned `facing`.** Same rule as cover: EASE, never assign.
  A strike that opens with an instant half-turn reads as the whole move being
  broken however good the clip is. `meleeTurnRate` (24 rad/s) covers a half turn
  in about 0.13s, which lands inside `meleeLungeTime`, so he is pointing at the
  target before the hit does. The LUNGE still goes along the flick angle, not
  along the facing that is catching up to it — driving it off the eased facing
  sends the first frames of a big turn the old way and curves him round.
* **three's `AnimationMixer` does not normalise weights.** Over 1 and the bones
  are pushed past every clip feeding them; under 1 and the remainder goes to the
  BIND POSE. Both are visible. Two bugs here, both measured on a real chain:
  * the tree was damped toward a target that had ALREADY been multiplied by
    `treeScale`, so it lagged the overlay it was meant to be making room for —
    the overlay rises on a 0.05 half-life and the tree got out of the way on
    0.075. Peak total **1.36**. Scale after the damping, not before, and the
    tree stays a normalised blend of itself worth exactly `treeScale`.
  * a strike landing on a strike had both at full overlay weight, because the
    outgoing one fell back into the tree and decayed on the tree's half-life.
    The overlay is now a SLOT worth `_oneShotWeight` that the two share
    (`_shotMix`), and `_lastShot` keeps the slot's weight pointed at the clip
    that earned it while it drains after `endOneShot` — dropping it into the
    tree there made the total dip to **0.79**, which is him going briefly limp
    on the way out of every strike.

  `tests/smoke.mjs` now asserts the total stays inside 1 +/- 0.02 through a
  chain. It is a cheap check and it would have caught both.

Two clip-level rules learned the hard way:

* **A one-shot's state must END it.** `stand_to_cover` was played and never
  ended, so its overlay sat at full weight forever and scaled the cover
  idle/sneak clips to zero — which reads exactly as "the cover animations never
  play", not as "a one-shot leaked".
* **Melee recovery is a FRACTION of the clip** (`meleeRecoverFrac`), never a
  fixed number of seconds. At a fixed 0.34s the long kicks were faded out
  mid-swing while the jab was barely touched, so most of the strike set was
  never actually visible.

The airborne pose is ONE clip, and it is `floating`, not `falling` — falling is
a face-down skydive, which is a pose for a long drop; floating is upright with
the legs under him, which is what a jump looks like. A ~1s hang is not long
enough to read a takeoff/rise/fall sequence; blending three across it looks like
a stutter.

### Cover: back to the wall, and the sided clips are a LEAN

He stands with his BACK to the wall, facing out along its outward normal, and
that facing does not change while he is on it. `cover_idle_left` and
`cover_idle_right` are a LEAN, not opposite facings — measured against the rig
they sit at only -25 and +25 degrees off the model's forward, and the sneaks at
+9 / -9.

Reading them as opposite facings (the first version) put him exactly 90 degrees
out — facing along the wall rather than off it — and made him spin 180 degrees
every time the side swapped. Measure a clip's authored facing rather than
guessing it: pose the model at mid-clip and read the Hips or Spine1 bone's world
+Z axis, with a plain forward walk as the control.

`stand_to_cover_left/right` are NOT used. They are a ~140 degree turn-around, so
playing one on entry spun him to face the wrong way and then snapped into the
idle. Easing the facing covers the transition without it.

**Never assign `facing` in a held state — ease it.** Setting it directly is what
made him teleport between rotations. A change of state has to be a turn you can
watch.

### Cycles ship with a duplicated last frame

Every locomotion take in this pack ends on a copy of its own first frame — the
normal way to author a cycle, so the last key visually matches the first. Played
as a loop that pose shows TWICE in a row, and at 24fps over a 14-frame sprint it
is a visible hitch every stride that reads as a limp.

`_trimLoopSeams` detects it and shortens the clip's DURATION by one frame; the
tracks are untouched, and since the whole tree scrubs `time = phase * duration`,
nothing lands on that frame again. It runs before `_buildDerived` so the
reversed back-pedal inherits the trim.

The epsilon is measured, not guessed. In this pack duplicates land between 2e-6
and 3.2e-4 depending on export rounding, while clips that genuinely end
elsewhere start at 3.0e-2 — two clear orders of magnitude, so the threshold sits
at 1e-3. A tighter 1e-6 silently missed `run_normal_forward` and both crouch
strafes.

### Reading frame counts off a clip

These are 24fps. When a clip needs its head trimmed, measure it rather than
guessing: `jump_flip` looks like it has ~15 frames of ground windup, but the
windup actually ends at frame 7 and frames 7-18 are the flip itself, so cutting
15 would remove half the trick. `CLIP=jump_flip node tests/clipstrip.mjs`
renders a filmstrip to check against.

### Hanging only matters above the jump

The apex is 4.0m, so anything shorter is a hurdle and he sails clean over it.
The test world's 5m wall exists for this. Two collision tests originally failed
for exactly this reason and the code was fine both times: one jumped a 2.4m
block, and one "no headroom" case put a thin slab above the ledge whose own top
he then caught instead — correct behaviour, passing for the wrong reason.

## Input is ported, not invented

`src/input/Joystick.js` came from Peggy, which got it from Robits, and it is the
way it is because of play-testing rather than design. Read the comment block at
the top before changing a threshold. The parts that look redundant and are not:

* **Floating origin** — the stick centres wherever the thumb lands. You never
  look at your thumbs on a phone.
* **The flick peak latch** — a flick can peak and return between two frames at
  30fps, and a per-frame sample misses it entirely.
* **Look is a RATE, not a position.** Right-stick deflection sets how fast the
  view turns, with a small deadzone (0.06) and a cubic-blend curve. Reading the
  stick's absolute direction instead, gated at 0.38, meant small pushes did
  nothing and the rim snapped the whole view round at once. Note `FollowCamera`
  had its own `> 0.05` gate on top, which threw the gentle end away again.
* **The right stick does not turn him at all.** Deflection is the CAMERA and
  nothing else; his facing belongs to the left stick, plus a right-stick FLICK,
  which points him at the strike. This went through an intermediate version
  where facing locked to the camera while the shoot trigger was engaged (0.40
  in, 0.26 out) — but with no weapons yet, that just meant standing still and
  looking around spun him on the spot. `Input.aiming` is now permanently false;
  when weapons land, a held deflection is what claims it back, and the aim
  camera hook in `main.js` is left in place for that. Note the side effect:
  the strafe clips only play while aiming, so at the moment they appear only in
  the tests.
* **Flick as a *candidate*** — a fast pan and a flick are both fast, so the flick
  can't fire on crossing a threshold. It resolves on what happens next: snapped
  back or released → flick; still travelling after 200ms → it was a pan. Camera
  deltas are buffered meanwhile so a melee never whips the view.
* **Repeat flicks within one touch.** The candidate arming deliberately does not
  test `_flickedThisTouch` — that flag only clears when the thumb lifts, and
  testing it there allowed exactly one flick per touch, which is why melee could
  not combo. `tests/gestures.mjs` pins this.

The camera pans on thumb *movement*, not held deflection. That is what frees the
out-and-still posture to mean "aiming", which is what makes hold-to-shoot work.

## App icons

`icons/`, all generated from `icons/icon_original.png` by
`python3 tools/make-icons.py`. That file is the master — replace it and rerun
the script rather than editing any of the eleven outputs. Three things there are
easy to get wrong:

* **Apple icons are full-bleed, with no rounded corners baked in.** iOS applies
  its own squircle mask, and pre-rounded art shows its own corners as dark
  notches inside that mask. iOS also ignores the manifest entirely and reads the
  `<link rel="apple-touch-icon">` tags, which is why those sizes are listed
  separately from the PWA ones.
* **Maskable icons need their subject in the middle**, not necessarily a pad.
  Android crops them to whatever the launcher likes and only guarantees the
  middle 80%. The current art is already composed for that — Big Don is centred
  and the background bleeds to every edge — so the maskable variants are the
  SAME full-bleed art. Scaling down and padding the border was tried and looks
  worse: the pad reads as a frame around the picture, and the mask then eats the
  pad instead of the art. If the art ever changes to something with the subject
  off-centre, that trade flips.
* **Favicons get a tighter crop.** The full picture is three characters, which
  below about 48px collapses into coloured mush. The 16/32/48 sizes come from a
  head crop of the centre figure (`FAVICON_CROP` in the script), which holds a
  readable blonde-on-blue silhouette at 16px.

## The bar for "done"

It runs on a phone, in portrait and in landscape, with two thumbs. Not "it works
if you also have a keyboard" — WASD exists so this is debuggable on a laptop, and
that is all it is for.
