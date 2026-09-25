# ADR 0167 — A redraw walks the tree once, frees only its own, and touches only what changed

Status: accepted.

## Context

A collaborator's edit froze the editor. Measured on the Roblox level (395 objects), headless Chrome on the real
GPU (Direct3D 11, RTX 5090): each rename, parameter or material change froze it **~520 ms** and re-linked 6 shaders;
a move cost nothing but still re-linked 2. The CPU profile:

| Part | ms |
| --- | --- |
| the document walked once **per lookup** — every object asked about in a redraw re-walked all 395, resolving every placement (`nodes()`, recomputed per call on purpose) | ~430: the 3D rebuild ~290, the Hierarchy ~115 |
| rebuilding every object's meshes, the rounded boxes mostly | ~45 |
| physics rebuilt at once | ~9 |
| the sky re-baked | ~1 |

And every rebuild **freed what it did not own**: the runtime's shared materials, each model's shape (a placed
model is a clone sharing its original's), the key cells' shape and material — so the next frame re-linked their
shaders and re-uploaded their shapes. It never freed the lights it had made, leaking their shadow maps.

## Decision

1. **`Doc.reading(pass)`**: inside a synchronous pass that only reads, the tree is walked once and held; any commit
   inside drops it, and nothing else can change the level in the middle of one. The 3D rebuild and the Hierarchy
   read through it. Outside a pass, a lookup still walks, so the note's guarantee — no cache to go stale — holds.
2. **Free only what the meshes made** (a node's shape, its grey or faded material, a gizmo's, a light), **two frames
   late**, once the replacement has drawn: a material freed first takes its shader with it when it was the last to
   use it.
3. **A remote batch redraws what it touched** (`remoteRepaint.ts`): each touched node's subtree, physics 150 ms
   later, the Hierarchy, the Inspector only when it shows one of them; the sky only for the environment. What
   renumbers the tree, a prefab's definition, a sequence (it may fade other objects), and **any op not on the
   list** still redraw everything.

After, same measurement: **0 ms** for a rename, a parameter, a material or a move; **0** shaders re-linked; a full
redraw (an insert, a removal) ~55 ms.

## Rejected

- **The sky and the materials only** (the investigation's option B). The walk was most of the cost.
- **A cache the document keeps between passes.** It would have to see every change made to the level from outside
  the document — a remote batch, hydration — and missing one addresses the wrong node.
- **Updating a selected object's Inspector fields in place** on a collaborator's edit to that object. The Inspector
  has no such path for component fields yet; it still rebuilds then, and no longer for anyone else's object.
