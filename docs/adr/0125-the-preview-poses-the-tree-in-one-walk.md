# ADR 0125 — The preview poses the tree in one walk

Status: accepted. Keeps ADR 0103's preview and the index-per-call rule at the top of `editorDoc.ts`.

## Context

Pressing **Motion** dropped the frame rate and made the viewport stutter. Play mode did not, which is the clue:
play never touches the document. It calls `loaded.update(nowMs)` and `loaded.render(alpha)` on the instantiated
frame tree — flat arrays, one pass.

The preview posed the editor's groups by asking the document per node, sixty times a second:

```ts
for (let i = 0; i < open.count(); i++) open.poseOf(i, previewMs)
```

Nodes are addressed by depth-first index and the list is **recomputed per call**, deliberately: a cache would
have to be invalidated by every mutation, including one made through the level object rather than the document,
and the day it missed, an index would silently address the wrong node. The note at the top of `editorDoc.ts`
says so, and adds "tens of nodes, so the walk costs nothing worth that risk."

That holds for an edit. It does not hold in a render loop. Each iteration cost four full walks — `count()`,
`node(i)` inside `poseOf`, `nodes()` inside `motionFrameOf`, and `node(i)` again — and each walk resolves every
placement against its prefab and bakes every override. `motionFrameOf` also climbs each node's ancestors
separately. Quadratic, per frame.

Measured, movers on half the nodes:

| nodes | `poseOf` per node | one walk |
|---|---|---|
| 100 | 1.16 ms/frame | 0.11 ms |
| 400 | **17.17 ms** | 0.20 ms |
| 1000 | **96.32 ms** | 0.21 ms |

17 ms a frame caps the editor at 58 fps before anything is drawn. 96 ms is 10 fps.

## Decision

**`Doc.posesAt(timeMs)`** — every node's pose, in document order, from one `nodes()` call.

It walks the list forward and carries each parent's accumulated rotation and scale **down**, which is the same
product `motionFrameOf` rebuilds by climbing up: a depth-first list puts a parent before its children, so its
accumulation is always ready. `motionPreview.applyPoses` calls it instead of looping `poseOf`.

**No cache.** The note at the top of the file stands untouched — `nodes()` is still recomputed per call. It is
simply called once per frame instead of `4n` times, which is the part that was wrong.

`poseOf` stays, for the one place that wants a single node on demand: the Inspector's offset field
(`offsetAt`), where a loop is not what is happening.

The property worth testing is that the two agree, so `posesAt` is checked against `poseOf` for every node at
five times on the five shapes that make motion composition hard — a turned node, a scaled parent, a turned
parent, and a parent that is itself spinning. Those fixtures already existed for ADR 0106, where the preview
and the loader disagreed about a `local` mover.

## Rejected

- **Cache `nodes()` with invalidation on commit.** The fastest fix and the one the file already argues against:
  an index addressing the wrong node is silent and corrupts an edit, where a slow preview is only slow.
- **Pose from the instantiated level, as play does.** It is the same data and already fast, but `loaded` is
  keyed by collider handle while the editor's groups are keyed by document index, so it needs a mapping that
  every structural edit invalidates — a second addressing scheme to keep in step.
- **Throttle the preview to 30 Hz.** Halves the symptom, keeps the quadratic, and makes the motion judder on
  purpose in the one feature whose job is showing motion.
