# ADR 0029 — Motion is a keyframe track, edited on a timeline

Status: accepted. Replaces the `move`/`rotate` behaviours of ADR 0014. Keeps the clock-driven invariant of
ADR 0013/0021 and the frame-tree composition of ADR 0025 untouched.

## Context

Motion was two behaviours. `move` translated a piece `distance` metres along `axis` and back, over
`periodMs`, eased by `(1 − cos 2π·t/T)/2`. `rotate` spun it about `axis`, one turn per `periodMs`. Both were
pure functions of synced time, which is what buys clock-driven objects zero per-object networking.

Kodjo's assessment: *"it's pretty much just an animation tool wrapped up in the worst UX ever imagined."*
That is three separate problems, and only one of them was UX.

**A data hole no UI could fix.** Motion was `nowMs % periodMs` with no offset, so **every mover sharing a
period was locked in step, permanently.** A staggered row of pistons was not authorable at all.

**A vocabulary that could not express the obvious.** Out-and-back on one axis, always moving. No pause at
either end. No path with a corner. No per-segment easing.

**And the UX.** You typed "3 m along +Y" into a property grid and imagined the result. The only way to see
motion was Play, which grabs pointer lock and suspends editing. No path drawn, no ghost, no scrub.

## Choice

**One behaviour: `track`.** A list of keyed poses, plus how it repeats.

```ts
type Behavior = { kind: 'static' } | { kind: 'track'; keys: Keyframe[]; loop?: LoopMode; phaseMs?: number }
interface Keyframe { t: number; position?: Vec3; rotation?: Vec3; easing?: Easing }
type Easing = 'linear' | 'in' | 'out' | 'inOut' | 'step'
type LoopMode = 'loop' | 'pingPong' | 'once'
```

Duration is the last key's `t` — derived, so the two cannot disagree. `phaseMs` shifts this track's clock,
which closes the lockstep hole. Evaluation is `poseAt(behavior, authoredTransform, nowMs)` in
`packages/content/src/track.ts`: pure, headless, no state, so the loader poses colliders with it and the
editor scrubs with it.

**No graph editor, and that decision drives the whole UI.** A graph editor unifies time and space into one
curve per channel — right for character animation, wrong for "this platform rises three metres and pauses",
where moving a platform sideways would mean typing numbers into three curves. So the job splits three ways:

- **Space in the viewport.** A polyline through every positioned key, a draggable handle on each, edited with
  the transform gizmo that was already the good part of the Inspector. The polyline is *exact*, not sampled:
  easing changes when the item is between two keys, never where, since every segment is a straight line.
- **Time in a strip.** A new Animation tab beside Project in the bottom row (both want the wide row: a file
  grid needs columns, a timeline needs a long axis). Diamonds on a ruler, dragged to retime, with the
  playhead scrubbing the whole level live — no Play mode, no pointer lock.
- **Easing as a label per segment.** Click it to cycle, or right-click a key for the menu.

What a graph editor would have added is per-channel easing: `pos.y` on a different curve from `pos.x`. Real
capability, and nothing in a parkour level wants it. The data model does not change if it is ever added —
only the panel gains a curve view.

**Rotation interpolates per euler component, not by slerp.** Forced, not preferred: slerp between identity
and a full turn is degenerate (they are the same orientation), so a spin could not be expressed at all.
Component lerp is also what a per-channel animation curve does. The cost is that arbitrary orientations do
not take the shortest path, and that the `Spin` preset is cardinal-axis only — a spin about a slanted axis is
not a straight line through euler space.

**A track replaces the frame's local pose, per channel** — Unity's model. A key with no `position` means
"whatever the transform says", so a translation-only track carries no rotation data and leaves an authored
tilt alone. Composition onto the *parent* is unchanged, so a keyed bar under a keyed platform still rides it.

**`move` and `rotate` became presets** (`moveTrack`, `spinTrack`) that write keys. `inOut` is cosine rather
than the usual quadratic pair specifically so a 3-key out-and-back reproduces `move` **term for term**.

**The gizmo's target depends on what is selected**, because there is no coherent single answer:

| selection | a gizmo drag writes |
| --- | --- |
| no track | the authored transform, as before |
| a track, a key selected | that key's pose |
| a track, no key selected | every key, offset by one delta |

Selecting a key parks the playhead on it, so the item is *already* drawn at that key — which is why the
gizmo needs no proxy object. It edits what it is sitting on. The third row is not a convenience: position
keys override the authored transform, so writing the transform would move nothing on screen and read as the
editor ignoring the drag. Dragging an animated platform moves its whole path, which the visible polyline
then shows.

## Consequences

- **All 10 authored behaviours migrated losslessly, and it was verified rather than asserted.** Every mover
  in the project used a cardinal +Y axis with no authored rotation, so both conversions are exact. Checked
  by evaluating the old formula against the migrated track at 25 ms steps across each full period: worst
  difference **4.4e-15**. Separately, the 25 existing loader and nesting assertions — exact positions,
  quaternions, carry velocities, movement-base indices — all pass unchanged against the new evaluator, which
  is the stronger evidence.
- **The editor and the game now draw the same level.** `buildItems` posed items at their authored transform
  while the game showed the track at t=0. Items are posed from the playhead now, so at 0 they agree.
- **The validator checks behaviours, and did not before.** A `move` was three numbers and hard to malform; a
  track is structure, and a `keys` that is not an array crashes mid-instantiate. `checkBehavior` reports a
  path instead. It reaches into prefab *pieces* — the only place this validator looks inside a prefab —
  because a piece is where a mover most often lives.
- **The Inspector lost its worst section** and holds transform, material, trigger and the prefab actions. A
  property grid can only ever show one instant of a track.
- **`Frame` keeps the authored `Transform`** instead of a pre-converted quaternion, since a track is
  evaluated against it every tick and its keys may leave a channel alone.
- **Scale is not animatable.** Scale bakes into collider dimensions at load, so a scale track would rebuild
  physics shapes every tick.
- **`loop: 'once'` is honest but rarely wanted.** The clock is the session's, not the player's, so a
  once-track has already finished before anybody joins a running room.
- **Nothing changed on the wire.** Motion is still a pure function of synced time, so movement bases
  (ADR 0021) replicate exactly as they did, and `isAnimated` still keeps static subtrees out of per-tick work.
- **Two behaviour-shaped things remain out of scope**, both deliberately: triggered motion ("moves when
  stepped on"), which is stateful and would cost replication, and blending or state machines.

## Rejected

**Keeping `move`/`rotate` and adding `track` alongside.** No migration, nothing breaks. Rejected because it
leaves three ways to say "this moves" and two of them strictly weaker — the same duplication ADR 0028 spent a
commit deleting.

**Adding `phaseMs` to `move`/`rotate` and editing the path in the viewport.** Roughly a fifth of the work,
and it fixes the lockstep hole and the worst of the UX. Rejected because it leaves the ceiling that prompted
this: still no dwell, still no corner, still one axis.

**Theatre.js** (`@theatre/core` + `@theatre/studio`), the only library that is genuinely this: keyframes, a
polished embeddable timeline, bezier easing, absolute `sequence.position`, built for three.js. Rejected on
three counts. Its studio is a floating overlay with its own chrome, so it fights the fixed-panel shell of
ADR 0024. It owns its own state format, so motion would either live outside `Level`/`Prefab` JSON or be
exported into ours, which is fighting the library. And its development went quiet, which is bad for something
load-bearing.

**three.js `AnimationMixer`,** already in the tree and able to sample at absolute times. Rejected because it
targets `THREE.Object3D`, so `@mp/content` would need three — or we would keep a shadow scene graph purely to
read poses out and hand them to Rapier. It also ships no UI, so it helps the half that needed no help and
couples the half that must stay headless.

**A timeline widget library.** Nearly all are React, and there is no React here. The vanilla exception
(`animation-timeline-js`) is built for multi-track compositing where the need is one object and a few keys.
The evaluator was never a candidate for a dependency: `lerpVec3` and `slerpQuat` already existed, and the
sim path has to stay dependency-free and deterministic.
