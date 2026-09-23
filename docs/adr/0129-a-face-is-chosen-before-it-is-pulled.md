# ADR 0129 — A face is chosen before it is pulled

Status: accepted, **amended below**. Keeps [ADR 0119](0119-a-face-is-a-handle.md)'s press — the first shape
of this, which required a face to be chosen before it could be pulled, was wrong and is recorded at the end.
Builds on [ADR 0128](0128-a-pull-moves-the-whole-selection.md); everything about which faces move and how far
is unchanged.

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

**A press takes the face under it, chooses it, and drags it. A click on empty space lets it go.**
The title is the shape this started as; the amendment below is what it became.

| | |
|---|---|
| press a face on a selected box | it and its matched set light up, are chosen, and the drag begins |
| drag | pulls, exactly as ADR 0128 describes |
| press and release without moving | chose that face and nothing else — the pull is aborted, so no entry lands in the history |
| pointer off every face | the chosen set stays lit: the highlight outliving the pointer is the whole point |
| click empty space | the choice is released, which is the way back to none |
| pointer travels more than `CLICK_SLOP` from empty space | an orbit, and the choice is untouched |
| tool change, or a selection that drops the chosen box | released (`clearFaceHover`) |

**The plates always show what a press right now would pull.** A face under the pointer wins, because that is
what a press would take; with the pointer off every face, the chosen set stays lit. One rule, and no state
where something is lit that a drag would not move.

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

## The amendment, and why

The first shape of this required the face to be **chosen** before a press would pull it, and drew the hover
preview only while nothing was chosen. Those two rules contradict each other: a face lit by hovering was, by
construction, one that `chosen` did not name — so the press refused it and fell through to orbiting the
camera. Both states drew the same plate in the same colour, so nothing on screen told the draggable highlight
from the one that would spin the view. It reached Kodjo's box and cost him two deploys.

The fault was not the extra click. It was **lighting something up and then refusing the gesture it invites**.
So the press claims whatever face it finds and chooses it on the way, which is ADR 0119's press exactly; what
ADR 0129 keeps is the highlight that outlives the pointer, which is what was actually asked for. A press with
no movement behind it is not a drag, so the same gesture still means "just choose this one".

## Rejected

- **Keeping the plates lit with no click**, the cheap version: the highlight persists but a drag still starts
  anywhere on a selected box. One gesture kept, and the lit faces stop meaning "what a drag will move" the
  moment the pointer moves off them. Offered; Kodjo chose the explicit model.
- **Choosing on release instead of on press.** Costs every face its one-motion pull for nothing.
- **Making the hover preview look different from the chosen one**, so the two states are told apart. It fixes
  the *telling* and leaves the trap: a press on a lit face would still sometimes orbit.
- **A separate keypress or modifier to choose.** A second thing to learn for a gesture that already has an
  obvious one.
