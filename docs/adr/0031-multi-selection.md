# ADR 0031 — Multi-selection, with a primary

Status: accepted. Extends the editor of ADR 0023/0024 and the shortcuts of ADR 0030.

## Context

Selection was `let selected: number | null`, read in 78 places across the composition root: the gizmo's target,
the Inspector's subject, the timeline's track, the track helper's path, delete, duplicate, copy, the write-back
of every transform edit. Laying out a level meant moving one platform at a time.

Turning that into a set would have touched all 78 sites, and most of them genuinely have exactly one subject —
a property grid cannot show three materials, and a timeline cannot edit three tracks.

## Choice

**A list plus a primary.** `selection: number[]`, ordered, and **the last entry is the primary**. `selected`
stays, derived as that primary.

That is the whole reason the change is small. Everything with one subject keeps reading `selected` and needed
no edit at all: the Inspector, the timeline, the track helper, the key-handle picking, the animation presets.
Only the operations that genuinely mean *all of them* read the list — transform, delete, duplicate, copy, cut.

The primary is also the anchor a Shift-range extends from, and a Ctrl-click makes what it adds the primary,
because a Ctrl-click is still a click and the thing just clicked is what the Inspector should show.

### Modifiers

| gesture | result |
| --- | --- |
| click | replace |
| Ctrl/Cmd + click | toggle that one |
| Shift + click (Hierarchy) | range from the primary |
| Ctrl+A | select all |

**Shift-range is Hierarchy-only, deliberately.** A range needs an order, and the viewport has none — what
looks adjacent on screen is an accident of the camera angle. Shift-clicking in the viewport toggles instead of
doing something arbitrary.

**The range runs over the visible rows, not over indices.** With a subtree collapsed, the rows on screen are a
subset whose depth-first indices are not contiguous, and a range means what the eye sees between two rows. The
panel passes its visible order into `rangeIn`, which keeps that knowledge in the panel and the function pure.

**Ctrl-clicking empty space is a miss, not a clear.** Losing a five-item selection to a stray click is the kind
of thing that stops people using multi-select.

### Structural operations act on roots, bottom-up

`rootsOf` drops any selected item that sits inside another selected item's subtree. Deleting a parent takes its
children with it, so deleting both would delete the child twice; duplicating both would produce the child
twice, once inside the copied parent. A depth-first walk makes this a scan: a node is inside the previous
shallower node's subtree.

Then **descending index order**, because removing or inserting only shifts the indices *after* the node
touched — so working from the bottom up leaves every index still to be processed valid, with no bookkeeping.
Duplication does need one correction, since a copy is a whole subtree and inserts more than one node: each
already-recorded new index shifts by however many nodes went in, measured as the change in `doc.count()`.

### The gizmo moves everything, by a delta

The gizmo attaches to the primary. Each `objectChange` writes the primary back, then mirrors its delta onto
every other selected item — each posed from **its own** drag-start snapshot plus the delta, never from its
running pose, so a hundred pointer events during one drag produce one offset rather than a hundred compounding
ones. That is the same rule the single-item track offset already needed, so `dragStart` became a map keyed by
index and serves both.

Snapshots are read off the scene group rather than from `doc.poseOf`, though at drag start the two agree.
Everything compared against a snapshot later is also read off a group, so both sides share one rounding and one
euler branch; mixing the stored euler with a re-derived one leaves a residue in the delta that accumulates over
repeated drags.

**Rotation and scale apply the same local delta to each item about its own origin.** They do *not* orbit the
selection about a shared pivot, which is what Unity does. Orbiting needs a pivot object and a decision about
where the pivot sits (centre of the selection, or the primary, with a toolbar toggle) — and moving several
things by the same amount is the case that comes up when laying out a level.

## Consequences

- **The Inspector edits the primary only**, and the status bar says so: `3 selected · editing goal pad`. A
  transform drag moves all three; typing a material changes one. That asymmetry is real and visible rather than
  silent, and the alternative — applying every property to every selected item — needs a mixed-value display to
  be honest about what it is about to overwrite.
- **The clipboard holds a list.** Copy takes the roots ascending, so a multi-item paste puts things back in the
  order they were in; paste selects everything it landed.
- **Undo restores the whole selection**, by sibling path rather than index, since an undone paste renumbers
  everything after it.
- **Dragging a row in the Hierarchy still re-parents that one row**, not the selection. Multi-reparent needs the
  same roots-and-order care as delete, plus a decision about what happens when the drop target is itself
  selected.
- **The primary is marked with an edge, not a different fill,** so the row still reads as selected.
- **It exposed a feedback loop through the Inspector that had been there since ADR 0029.** Tweakpane's
  `refresh()` calls `fetch()`, which assigns `rawValue` — and that emits `change` whenever the value differs,
  indistinguishably from a keystroke. So `inspector.sync()`, called on every `objectChange`, re-entered
  `writeTransform` on every frame of a drag. That deleted the primary's drag snapshot, so the mirror bailed
  after the first frame: **one object moved and the rest froze**, in all three modes. Rotation was worse, since
  the re-entrant write dropped a near-zero `t.rotation` and the re-pose then snapped the object back to
  identity. Fixed at the source — `sync` holds a depth counter and the change handlers ignore anything raised
  while it is set — plus a second guard so a typed Inspector value cannot land mid-drag at all. It had been
  quietly breaking single-item drags of an *animated* item's path too, where the re-entry re-snapshotted the
  track every frame and the offset came out as zero.
- **A selection is only valid until the next structural edit**, because indices shift. `clampTo` is the safety
  net for a list held across a rebuild that shrank the document; `applySelection` runs it on every change.

## Rejected

**A `Set<number>` with no primary.** The honest data structure for "which are selected", and it makes the
membership test cheaper. Rejected because a set has no answer to "which one does the Inspector show" or "which
one does a Shift-range anchor on", so both would have to be stored beside it anyway — at which point the
ordered list carries the same information with one field.

**Replacing `selected` everywhere with the list.** Rejected as 78 call sites of churn to reach the same
behaviour: the ones that matter read the list today, and the rest have one subject by nature.

**A pivot object for multi-transform,** as Unity has. It is the more capable answer and would make rotate and
scale orbit correctly. Deferred rather than dismissed: it needs the pivot placement decision (centre versus
primary) surfaced as a toolbar toggle, which is a UI question of its own.
