# ADR 0129 — A face is chosen before it is pulled

Status: accepted. **Reverses the central decision of [ADR 0119](0119-a-face-is-a-handle.md)** — the face is no
longer the handle. Builds on [ADR 0128](0128-a-pull-moves-the-whole-selection.md); everything about which
faces move and how far is unchanged.

## Context

ADR 0119 took SketchUp's model: hover a face, drag it, done. No click to select first, because "a face is a
big target and there is nothing else to aim at". One gesture per pull.

The highlight followed from that. It was drawn on hover and cleared the moment the pointer left, because
there was nothing for it to outlive — the drag either happened now or it did not.

ADR 0128 then made one drag move a face on every selected box, and drew a plate on each. That is when the
hover-only highlight stopped being enough: the plates are the only way to see which face a box rotated away
from the others will move, and they vanish as soon as you look away from them. Kodjo asked for the highlight
to stay. Offered the cheap version — the plates simply persist, dragging unchanged — or the full one, he
chose the full one knowing a pull becomes two gestures.

## Decision

**A click chooses a face. A drag on the chosen face pulls it. A click anywhere else lets it go.**

| | |
|---|---|
| click a face on a selected box | it and its matched set on the other selected boxes light up, and stay lit |
| press on the chosen face and drag | pulls, exactly as ADR 0128 describes |
| press on any other face, or empty space | the choice is released; a face under the pointer becomes the new one |
| pointer travels more than `CLICK_SLOP` | an orbit, not a click: the choice is untouched |
| tool change, or a selection that drops the chosen box | released (`clearFaceHover`) |

**Chosen and pulled in one press where it is already chosen.** The press decides, not the release, so a face
you have chosen still pulls in a single motion. Only the first pull on a face costs the extra click.

**The hover preview runs only while nothing is chosen.** Otherwise two sets of plates would be lit and
neither would say which one a drag moves.

**What is chosen is the whole matched set, not one face** — the same set `facesForSelection` hands the drag.
The plates would otherwise promise less than the pull delivers.

## Why this and not ADR 0119's model

0119's reasoning still holds on its own terms: a face is a big target, and select-then-drag is a gesture
nobody needs when only one thing can move. What changed underneath it is ADR 0128. Once a drag moves five
boxes and picks a different face on each by a rule you cannot run in your head, being able to *look* at the
answer before committing is worth more than the gesture it costs. A highlight that only exists while the
pointer is on it cannot be looked at, because looking away is what dismisses it.

## Where the clearing happens

In `reattachGizmo`, not in `applySelection`. Every selection change goes through it, and the editor's host
entries are arrows (ADR 0121): `pickTool` is constructed well below the selection code, so calling it from
there directly would reference a `const` in its temporal dead zone.

## Rejected

- **Keeping the plates lit with no click**, the cheap version: the highlight persists but a drag still starts
  anywhere on a selected box. One gesture kept, and the lit faces stop meaning "what a drag will move" the
  moment the pointer moves off them. Offered; Kodjo chose the explicit model.
- **Choosing on release instead of on press.** Costs the chosen face its one-motion pull for nothing.
- **A separate keypress or modifier to choose.** A second thing to learn for a gesture that already has an
  obvious one.
- **Leaving the hover preview running under a chosen face**, dimmer. Two sets of plates, and the question
  "which of these moves?" is the one the feature exists to answer.
