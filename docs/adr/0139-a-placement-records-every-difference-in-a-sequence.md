# ADR 0139 — A placement records every difference in a sequence

Status: accepted. Applies [ADR 0135](0135-a-difference-is-recorded-on-any-piece.md)'s model to the stages and
steps of [ADR 0137](0137-motion-is-a-sequence-of-stages.md). Fixes a gap in
[ADR 0098](0098-a-placement-can-override-its-prefab-roots-components.md) that sequences made unavoidable.

## Context

A sequence is a list of lists, and a params override replaces a key whole. Recording a placement's edit as
its whole `stages` value would cut the placement off from its prefab: change one step's speed on one copy,
and every later edit to that sequence in the prefab would stop reaching it.

The first proposal was to accept that for structural edits and record values only. Kodjo sent it back: the
project already answers the question. A prefab in a level behaves like any other object and still is a prefab
(ADR 0135) — every difference recorded, revertable, appliable, nothing left out.

## Decision

**`NodeOverride.sequences`, keyed by component id, holds how that placement's sequence differs** — ADR 0135's
model with stages in the place of parents and steps in the place of children:

| | |
| --- | --- |
| `steps` | step id → the fields that differ, sparse (`target: ''` = the object itself; a different `kind` = the whole step) |
| `removedSteps`, `removedStages` | what this placement does without |
| `addedSteps`, `addedStages` | what it adds |
| `layout` | the order of stages and of each one's steps, **only** when the rest would give a different one. A preference, like `childOrder`: gone ids skipped, unmentioned ones at the end — so a step the prefab gains shows up rather than invalidating the record |

**The editor diffs; it never builds a record by hand.** It knows the sequence a person is looking at;
`diffStages(prefab, shown)` turns that into the record and `stagesFor(prefab, record)` turns it back. The two
are inverses — asserted over a thousand random edits — so every edit to a placement's sequence, a value or a
stage dragged somewhere else, is **one op**, `setOverrideSequence`, carrying the whole difference. Holds
(ADR 0089) already stop two people editing one node at once, so a whole-record op contends with nobody.

**Apply** writes the stages the placement shows into the prefab, which is what Apply means everywhere else.
**Revert** drops the record. Removing the component on the placement drops it too.

**A step's target is a node reference.** Duplicating, copying, or unlinking a prefab re-mints ids and repoints
`nodeRef` parameters; step targets now follow the same map, or a duplicated door would go on opening the
original's halves. Unlinking repoints the placement's **own** components as well as its inherited children's —
a sequence on a prefab root always targets that root's children, and the root's components were outside the
re-minted forest.

## The placement's root

A change to a component on a placement's **root** — inherited from the prefab's root — has been written since
ADR 0098, on the placement, keyed by the prefab root's id. Nothing read it back: the override strip, Apply,
Revert and the overridden-row marks all looked a record up by piece, and the root is not a piece. ADR 0122's
premise, "the root holds no override of its own and never will", had stopped being true with ADR 0098.

A moving platform's sequence usually sits on its prefab's root, so this had to work. `recordKey` now answers
where any node's record lives, the root's included, and the root is the first entry of
`placementOverrides` — counted, applied to the prefab's root, reverted.

## Rejected

- **Recording the whole stages on a structural edit.** Cuts the placement off from its prefab for that
  sequence — the "left out" Kodjo has asked not to see again.
- **Granular ops per kind of difference** (`insertOverrideStep`, `setOverrideStepRemoved`, …), as pieces
  have. More code to keep inverse-correct for no gain: nothing else edits the record, and holds make the
  whole-record op safe.
- **Deep-merging params patches** so a list could be patched in place. It would change every parameter's
  override semantics — a collider that changed shape would keep the old shape's fields.
