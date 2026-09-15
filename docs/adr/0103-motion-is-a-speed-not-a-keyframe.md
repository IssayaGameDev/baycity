# ADR 0103 — Object motion is a speed on a component, not a keyframe track

Status: accepted, landing in stages. Supersedes [ADR 0029](0029-keyframe-tracks.md) (motion is a keyframe
track), [ADR 0037](0037-timeline-edits-a-parameter.md) (the timeline edits a declared parameter),
[ADR 0050](0050-tracks-are-offsets-and-assets.md) (a key is an offset, a track can be an asset) and
[ADR 0051](0051-dope-sheet.md) (the Animation panel is a dope sheet). Keeps the clock-driven invariant of
ADR 0013/0021, the frame-tree composition of ADR 0025 and the offset model of ADR 0058 untouched.

## Context

Kodjo's verdict on the keyframe system: *"way too complex for what we're trying to do and not intuitive at
all"*, and on the panel, *"delete the animation window entirely. The window is bad."*

A survey of what the system was actually used for settled it. Across every level and prefab in the repo there
are **17 `Track` components resolving to 7 distinct animations**:

| authored shape | count |
| --- | --- |
| an eased out-and-back on one axis (the `Move` preset's exact output) | 5 |
| one full turn about +Y (the `Spin` preset's exact output) | 1 |
| three keys all at `t = 0`, duration zero, **moves nothing** | 1 |

No hand-keyed path. No corner. No pause. `phaseMs` used zero times. A non-default `loop` zero times. The one
animation **clip asset** on disk was referenced by nothing.

Serving those seven cost **2,070 lines** across `track.ts`, `timeline.ts` and `trackEdit.ts`, 102 tests, ~215
lines of CSS, a tab, a set of draggable path handles in the viewport, a record mode, and a whole asset kind
with its own file extension, importer branch, lock-on-select and eager glob in three bundles.

Two further pieces of evidence, both from the authored data:

- The distances read `10.1`, `10.2`, `1.2`. Nobody types those. They are drag artefacts: the panel made it
  easier to smear a value than to set one.
- The dead track is live content. A person dragged keys until the duration was zero, `isAnimated` returned
  false, the platform silently stopped being a platform, and nothing in the UI said so.

## Decision

**Motion is a component with a speed on it.** Two of them, and no panel at all.

```ts
Mover   { move: vec3 (metres from rest), speed: number (m/s), smooth: bool, offset: number (cycles) }
Spinner { axis: enum (±X ±Y ±Z),         speed: number (°/s),                offset: number (turns) }
```

The Inspector already draws vec3, number, bool and enum rows, so there is no animation UI to build, and none
to go stale. Making a platform move is: select it, add a `Mover`, type a number.

### A speed, not a period

The keyframe form authored a duration and let the speed fall out of it. So making a platform travel further
silently made it faster — which is the road to [ADR 0042](0042-fast-vertical-platforms.md)'s riding bugs,
every one of which was found by a platform being faster than the carry system expected.

Here distance and feel are independent, and the authored number is the one that decides whether a platform
can be ridden or jumped onto. It is also in the same unit as the character's own `moveSpeed`, so the two can
be compared without arithmetic.

`speed` is the **average over a leg**: a leg takes `distance / speed` seconds whether `smooth` is on or off,
so the curve redistributes time inside a leg and never changes the cycle length.

### `offset` is a fraction, because the period is derived

A staggered row of pistons is the reason a phase offset exists at all, and it is the one thing `Track`'s
`phaseMs` could express that nothing ever used. Kept, but as a fraction of the cycle rather than a time: the
cycle length is now derived from speed and distance, so a time would go stale the moment either changed and
every platform in the row would have to be re-authored.

### `Mover` is repeatable, `Spinner` is a singleton

Offsets from one transform add, so an up-and-down plus a side-to-side a quarter cycle apart is a circle. That
is the compound path keyframes were needed for, recovered for the cost of not setting `singleton`.

Two spinners is not the same offer. The contribution is euler radians, and summing euler angles about two
axes is not composing the two rotations — the result depends on order. Same constraint makes `axis` an
**enum** rather than a vec3: a turn about a slanted axis is not a straight line through euler space, so a
vec3 would accept `(1,1,0)` and produce something that is not a diagonal spin. `spinTrack` already had this
limit and dodged it by silently taking the dominant component.

### Repeatable components, not a list inside one

Considered and rejected: one `Mover` holding a list of translations. Three reasons, in order of weight.

**Overrides key on a component id, which is stable; a list index is not** (ADR 0033). Overriding "the second
translation" on one placement and then reordering the list in the prefab would silently repoint that
override.

**There is no list parameter kind**, so it would mean a new spec kind, a repeating group in the Inspector
with add/remove/reorder, and new ops — a bespoke panel, which is the thing being deleted.

**Repeatable is already free.** `Collider` is repeatable today; each instance gets its own Inspector header
and its own enable tick, which a list would have had to rebuild.

### Loader-evaluated, not a `self.offset` hook

`Mover` and `Spinner` have no hooks. The loader evaluates them as `offset = f(params, time)` while building
the frame tree, exactly as it did `Track`, and composes them with what a track sampled and what a component
drove — all three are offsets from the same authored transform, so they add.

A component hook writing `self.offset` (ADR 0058) would have been the tidier architecture, with no privileged
component names in the loader. It was rejected on one fact: **the editor only runs the component runtime
during play-in-place**. A hook-driven mover would be invisible while editing, and the viewport showing
something the game does not build is the failure this whole area is being rewritten to end.

## Migration

Every authored track is preset output, so the conversion is arithmetic:
`speed = 2 · distance / period` for a mover, `speed = 360 / periodSeconds` for a spinner. Both reproduce the
old pose **exactly**, and `motion.test.ts` asserts it over a sweep of times against `moveTrack` and
`spinTrack` themselves, which is the migration proof carried as a test.

The dead zero-duration track moves nothing today, so migrating it faithfully means dropping the component.

Content is converted on the box by a script, like the primitives and prefab-reference migrations before it,
never by editing `content/` locally (ADR 0083/0084).

## Consequences

- **Arbitrary keyed paths stop being authorable.** A platform that moves in an L, or pauses at the top, needs
  a component written for it. Nothing in the repo does either, and Kodjo accepted the trade knowingly.
- **A clip can no longer be shared between objects.** The `animation` asset kind, `.anim.json`, and the whole
  clip pipeline go. Nothing referenced the one clip that existed.
- `Behavior`, `Keyframe`, `Easing`, `LoopMode`, the `keys` parameter kind, `timeline.ts`, `trackEdit.ts`, the
  panel's CSS and tab, the viewport's path handles and record mode all go with the window. About 2,400 lines
  out against 150 in.
- **Two spinners cannot be authored**, and the editor has to say so rather than accepting the second one.
- `Spinner`'s angle wraps at a full turn rather than accumulating, because level time runs for the life of the
  room. A turn of 2π is the orientation it started from, so the wrap is invisible — and it is the same jump
  the keyframe form already made at its loop point.

## Rejected

**Keeping the data model and replacing only the UI** — `Track` keeps its keys, and the Inspector shows
axis/distance/period fields that write the preset. Deletes less, and leaves a keyframe schema whose only
authoring surface is two fields: a data model pretending to be more than it is.

**A curve editor.** Rejected twice before (ADR 0029, ADR 0051) and now moot.

**A list of easings instead of `smooth`.** Cheap to build, since `easeAt` already had five curves, but three
of the five are wrong on a looping out-and-back: `in` arrives at the far end at full speed and restarts the
return from zero, `out` does the mirror, and `step` does not move at all. They exist for a segment between
two *different* poses, which is a keyframe idea. A bool cannot be set to something that jerks.

**A `pause` at each end.** A real gap (ADR 0029's own notes list it), and not expressible as a curve. Left
out until a level needs it.

**A trigger-started mover** — a platform that runs only once stepped on. A separate component built on
ADR 0058's `self.offset`, not a field here: it stops being a pure function of the clock, which then raises
what two players who joined at different times each see.
