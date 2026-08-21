# ADR 0050 — A keyframe is an offset, and a track can be an asset

Status: accepted. Amends ADR 0029 (the track schema) and ADR 0037 (the timeline edits a parameter). The
clock-driven invariant of ADR 0013/0021 and the frame-tree composition of ADR 0025 are untouched.

The last consequence below — "the timeline cannot yet edit a clip" — was true for one commit and is not any
more: [ADR 0051](0051-dope-sheet.md) rebuilt the panel, and it opens a clip directly.

## Context

ADR 0029 replaced `move`/`rotate` with a keyframe track and got the vocabulary right: dwell, corners,
per-segment easing, `phaseMs` to break lockstep. What it got wrong was what a key *means*.

**A key was an absolute local pose.** `poseAt` returned the sampled key, and the node's authored `transform`
was dead data for any channel the track touched. Four consequences, all of them felt:

- **A track was welded to one spot.** Duplicate a moving platform, drag the copy ten metres away, and it
  snapped back to the original's path — because the keys, not the transform, said where it was.
- **A track could not be shared.** Two nodes playing the same key list would occupy the same place. So there
  was no such thing as a reusable motion, and no asset kind could have existed.
- **The transform lied.** The Inspector showed a position that the track overrode. Editing it did nothing.
- **The editor paid for it.** A gizmo drag with no key selected had to rewrite *every key* by a delta,
  against a snapshot of the pre-drag keys, because writing the transform would have moved nothing on screen.
  That snapshot existed only to stop a hundred pointer events from compounding into a hundred offsets, and a
  typed Inspector value needed the same snapshot faked for it.

Kodjo's verdict on the animation editor was that it should be scrapped. The panel is the next piece of work;
this is the part underneath it, because rebuilding the panel on absolute keys would have kept every ceiling
above.

## Decision

### 1. A key is an offset from the node's transform

`poseAt` **adds** the sampled key to the authored transform, per channel. A key of zero is the rest pose.

```ts
position: posKeys.length === 0 ? base.position : add(base.position, sample(posKeys, u))
rotation: rotKeys.length === 0 ? rest         : add(rest,          sample(rotKeys, u))
```

A channel with no keys still falls through to the authored value — and does so by being returned untouched
rather than by adding a zero, so the identity is exact and there is no allocation for a track that only
translates.

The transform is now where a thing lives and the track is what it does there. That is the whole ADR; the rest
follows from it.

### 2. An animation clip is an asset, and a `Track` may name one *or* carry keys inline

`content/assets/animations/*.anim.json`, with a `.meta` sidecar for identity like every other asset kind
(ADR 0026). The file holds `keys` and nothing else.

`loop` and `phaseMs` stay parameters of the `Track` component, deliberately: they are per-placement. A
staggered row of pistons is **one clip and six phases**, and the same clip looping on one platform and played
once on another is ordinary. So a clip is the shape of the motion in time, and how it repeats belongs to the
thing playing it. One field, one home, no precedence table.

**Both sources are supported.** Kodjo asked for this against a recommendation of clip-only, and the reason
clip-only was recommended — two code paths — turned out not to apply:

- `poseAt` never learns the difference. It takes keys.
- The loader resolves it in one function, `keysOf`.
- The editor's timeline already addressed keys through `keysOf`/`setKeys` (ADR 0037), so the panel is unaware.

The branch lands in exactly two places, and one of them is four lines.

**Inline keys win** when a file has both. Most-local-wins, the same rule a node's own `MaterialOverride` has
over an inherited one. The editor keeps the two exclusive, so this only ever decides a hand-edited file; the
point of having a rule is that such a file is never ambiguous.

A `clip` naming a missing asset resolves to no keys, so the node stands at its transform. A dangling
reference is a mover that stopped moving, not a level that fails to load — the same choice ADR 0026 made for
a missing material.

### 3. `ClipSource` is a capability, not an import

```ts
export interface ClipSource { readonly keys: (assetId: string) => readonly Keyframe[] | undefined }
export const instantiateLevel = (world, level, types: TypeInfo, clips?: ClipSource) => …
```

Passed in, like `TypeInfo`, because `@mp/content` is headless and does not fetch files. Optional, so a caller
with no asset layer still loads a level whose movers are inline.

Each app supplies its own, all three by the route it already used for materials: parkour globs `*.anim.json`
at build time, the viewer does the same (it greyboxes everything and resolves no materials, but a clip is not
a surface — motion is what that tool is for), and the editor reads them over the dev server's asset routes.
The editor's is a stable object that reads the library on each call, so a clip created mid-session resolves
without rebuilding the document.

## What this deleted

The editor's write-back is where the change pays for itself. ADR 0029's three-row gizmo table is two rows:

| selection | a gizmo drag writes |
| --- | --- |
| no key selected | the authored transform — animated or not |
| a key selected | that key's offset |

The animated case *is* the plain case now. Gone with it: `DragStart.keys`, the per-key delta rewrite, the
compounding guard, and the fake snapshot `writeTransform` had to take before a typed value could land. The
whole-track drag is a subtraction — strip the track's contribution at the playhead off the posed group and
what is left is the transform — so there is nothing to accumulate.

`moveTrack`/`spinTrack` lost their `base` parameter, and `oneKeyAt(pose)` became `restKeys()`. A preset is
correct for an object wherever it stands, and a fresh track holds the object where it is instead of baking
its pose into a key that then overrode every later transform edit.

`pathPoints` gained a `base`, since a key alone no longer says where anything is.

`InspectorHost.materials()`/`models()` collapsed into `assetOptions(of)`, and `onCreateMaterial(folder)` into
`onCreateAsset(kind, folder)` — a third copy of each was the alternative.

## Migration

13 authored tracks across 7 files. Per channel: the earliest key's value becomes the transform, and every key
becomes a delta from it. Exact by construction, and the transform it writes is the pose the object rests at,
so the files read better than they did (`"y": 2.5999999999999996` became `"y": 1.2`).

Verified twice, because the first check could have been hollow:

1. The migration script compared old semantics on the old file against new semantics on the new one at 25 ms
   steps across each full period — **3866 sample points, worst difference 1.78e-15**.
2. That script reimplemented the old evaluator from reading it, so a misreading would have made both sides
   wrong together. A throwaway test then ran the **real** `poseAt` from `HEAD` against the real new one over
   every file whose committed state was pre-migration — 8 of the 13 tracks, covering both channels. Identical.

Three of the 13 were already authored with a zero first key at the origin, so the migration was a byte-level
no-op on those files, which is its own small confirmation.

## Rejected

**Clip-only, no inline keys** (recommended). One way to say it, in the spirit of ADR 0028. Kodjo chose both,
and the cost that justified the recommendation did not materialise — see above.

**`loop` in the clip.** It makes a clip a more complete unit, and a standalone clip preview would not have to
default. Rejected because it splits `loop` across two homes the moment inline keys exist, and because a
3-key out-and-back barely notices the difference.

**A migration that leaves the transform alone**, rewriting each key as `key − transform`. Also exact, and it
touches one field less. Rejected because it leaves the transform holding whatever stale value it had and the
keys holding the difference from it — arithmetically fine, unreadable as authored data.

**Threading `ClipSource` through `levelDoc`'s 60 call sites, or holding it in a module global.** It is a
fourth optional parameter that only `main.ts` passes; tests get the default and are untouched.

**Multi-node clips**, where one clip animates a whole subtree by node path (Unity's `AnimationClip`). Real
capability — one `door-open` driving both leaves and a handle — and Kodjo chose one-node clips. It needs node
paths that survive prefab overrides and renames, and roughly doubles the work.

**Named clips selected at runtime.** No consumer: motion is clock-driven, so nothing exists to choose between
two clips. Triggered motion was considered and declined again (it needs per-object state on the wire, which
ADR 0029 parked).

## Consequences

- A moving platform can be copied, moved and reparented, and it keeps its motion. This was the reported
  symptom.
- One clip drives many movers, each around its own rest pose, each with its own phase. Pinned by a test that
  loads two nodes at different transforms from one clip.
- The Inspector's transform is live for an animated object. It shows the posed pose at the playhead and a
  typed value lands on the transform underneath, which is what a drag does.
- `Track` gained a `clip` parameter, so `DEFAULT_REGISTRY.defaults('Track')` is
  `{ clip: '', keys: [], loop: 'loop', phaseMs: 0 }`.
- `AssetKind` gained `'animation'`. The exhaustive `Record<AssetKind, …>` in the Project panel was the only
  place that had to change, which is what that type is for. Clips are `UNPREVIEWABLE` — no picture worth
  inventing yet — and `CREATABLE`, so the panel offers `+ new animation`.
- **Nothing changed on the wire.** Motion is still a pure function of synced time, so movement bases
  (ADR 0021) replicate exactly as before, and `isAnimated` still keeps static subtrees out of per-tick work.
- **Scale is still not animatable** (ADR 0029's reason stands: scale bakes into collider dimensions at load).
- `content/assets/animations/rise-4m-4s.anim.json` is a demo clip — the `moveTrack(+Y, 4, 4000)` preset as a
  file — so the kind is non-empty and the path is verifiable end to end. Nothing references it.
- **The timeline cannot yet edit a clip.** It edits the component's inline `keys`, as it did. A clip is
  authored by hand or created empty from the Project panel. The panel rebuild is the next piece of work, and
  `Save as clip` / `Unlink` belong to it.
