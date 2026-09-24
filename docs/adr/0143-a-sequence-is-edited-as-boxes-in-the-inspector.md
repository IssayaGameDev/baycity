# ADR 0143 — A sequence is edited as boxes in the Inspector

Status: accepted. The editing half of [ADR 0137](0137-motion-is-a-sequence-of-stages.md). Every layout choice
here is Kodjo's, asked one piece at a time with two options each; the brief lists them.

## Context

ADR 0103 deleted an animation window Kodjo called bad. A sequence still has to be editable — stages that run
one after another, steps inside them that run together — and a Tweakpane property grid has no list, no
grouping and no drag.

## Decision

**In the Inspector, as the `Sequence` component's section**, drawn with our own DOM (`sequenceEditor.ts`); the
edits themselves are pure functions (`sequenceEdit.ts`) tested without a browser.

| | |
| --- | --- |
| header | `Sequence  <name>`, then a summary of **only the settings that differ from the defaults** and the pass length (`sequenceSummary`); a local clock always shows. ⚙ opens the settings — name, clock, axes, loop, times, offset — as ordinary parameter rows. ⚠ when anything inside will not work as written |
| stages | **boxes**, the stage's length in the corner |
| steps | **one line each** (`stepLine`, the brief's table); a click opens its fields underneath, and which are open survives the rebuild every edit causes |
| add | a `+` inside a box while it is hovered adds to that stage; `+ stage` adds one at the end; both open the kinds menu |
| remove | `×` on a row while hovered; right-click a step or a box for duplicate and delete |
| drag | by a grip: a step into a box joins it, between boxes becomes a stage of its own, a stage moves by its box, and either can go into another sequence on the same object — **one edit** (`Doc.setSequencesStages`). A stage emptied by a move disappears |
| target | a step aims at the object or one of its direct children (`Doc.childTargets`) |
| warnings | the engine's problems, and a target that is gone, on the row or box with the reason on hover; the rest still runs |
| on a placement | a step or stage the placement **changed or added** wears the override bar every other overridden row in the Inspector does (Unity's cue); the header's count includes changed, added and removed steps. Kodjo's pick over a word on the row |

**Every gesture is one `commit` of the stages as they should now be.** The document decides where they live
and, on a prefab's piece, what differs (ADR 0139) — so the editor never knows whether it is editing a node, a
placement's copy or a component added to a placement.

**A multi-selection edits the settings they share, not stages**: stages differ per object, and there is no
honest blank for a list.

**A placement root's inherited components are inherited.** `ComponentView.inherited` answered by node, so a
component the root showed from its prefab counted as its own, and its ⋯ offered "Reset to defaults" — which
writes an override for every parameter — instead of "Revert to prefab". Per component now; a sequence on a
prefab's root is the common case.

**`Sequence` joins the shared components**, adopted by a game the first time one is added to its level
(ADR 0077), like `Mover`.

New steps start at a second, linear: a move to one metre up, a turn of 90° about up, a scale of ×1.5, a fade to
0, a wait of a second.

## Rejected

- **A panel of its own.** A second place to look, and the kind of window ADR 0103 removed.
- **Settings always showing.** Six rows above the steps of every sequence, set once and rarely touched.
- **Brackets instead of boxes.** One line saved per stage, and "runs together" reduced to a single glyph.
- **Every field of every step always open.** Four rows a step; a sequence would not fit on the panel.
- **A scrub bar.** Kodjo chose the Motion button alone.
