# ADR 0037 — The timeline edits a declared parameter, not a privileged component

Status: accepted. Narrows ADR 0029 (which introduced the timeline) to fit the component system of ADR 0035.

## Context

Kodjo: *"currently animations like spinning etc — just an animation component is not really a component or
integrated with the component system you just created. Currently it's just a tab on the bottom part of the
layout, which is very bad."*

Half of that was already fixed and half was worse than the tab. `Track` **was** a component after ADR 0035:
in the registry, in the JSON, overridable per placement, listed in the Inspector. What was not a component was
the *editing*, in four specific places:

- `Doc` had `trackOf` and `setTrack` — bespoke methods for **one** component type. No other component had any.
- The Animation panel sat beside the Project browser and addressed "the selection's track", so it belonged to
  the editor rather than to anything you could point at.
- The Inspector's Track section said `3 keys — edit on the timeline` and gave **no way to get there**.
- `loop` and `phase` existed twice: as declared parameters in the component's section, and again as controls in
  the strip's toolbar.

## Choice

**The strip edits `(node, componentId, param)`** — a `KeyEditor` — where `param` is any parameter whose
declaration is `{ kind: 'keys' }`. `Track` is the only component that declares one today; a second one would be
editable by the same strip with no new plumbing. `Doc.trackOf`/`setTrack` are replaced by
`keyEditors`/`keysOf`/`setKeys`, none of which names a component type.

**The strip stays wide and stays in the bottom row.** A timeline needs horizontal room: a ruler, a key row and
a playhead in a 300px Inspector column is worse than the problem being solved, and Unity keeps its Animation
window out of the Inspector for the same reason. What changed is ownership, not location — it is opened from
the component's own section, and its heading names what it is editing (`elevator · Track.keys`).

**`loop` and `phase` are gone from the toolbar.** They are declared parameters, so the Inspector already draws
them from the declaration; a second copy is what made an animation feel like it lived somewhere else. The
strip's preview clock reads `loop` off the open component **by name**, defaulting to `loop` for a keyframe
parameter whose component does not declare one.

**A preset writes keys and nothing else.** It used to rewrite the whole component, which quietly reset `loop`
and `phase` — a preset has no opinion about either.

**Clearing keys and removing the component are different things now,** and both are reachable. `Clear keys`
empties the array and leaves the component; `Remove` in the Inspector takes the component away, which on a
placement records a structural override. Under `setTrack(null)` those were one operation.

## Consequences

- **A `keys` parameter renders as a count plus a button** in the Inspector: `3 keys` / `Edit keys on the
  timeline`. The dead end is gone.
- **A fresh `Track` is empty**, and an empty track is static — so adding the component moves nothing until
  there is a key. Honest, and it is what makes "add the component" and "author the motion" two steps instead of
  one that guesses.
- **The strip's target follows the selection** when there is exactly one keyframe parameter, which is every
  case that exists. The Inspector button is what picks a different one.
- **Write-back is per item, not per selection.** A multi-selection drag routes each item through *its own*
  component; the strip's target only says what the panel has open.
- **`TrackEdit`, `LOOP_MODES` and `trackFrom` are deleted.** The first two had no readers left; `trackFrom`
  became `oneKeyAt`, keeping the reasoning that a fresh track is one held key rather than two, because two
  invent a duration nobody chose.

## Rejected

**Moving the strip into the Inspector's Track section.** It is the literal reading of "wrapped under the
components" and it makes the tool worse: a timeline is a horizontal instrument. Ownership was the real
complaint, and ownership is fixable without moving anything.

**Keeping `loop` and `phase` in the toolbar as a convenience.** Two editors for one value is how they drift,
and the Inspector's copy is the one generated from the declaration.

**Keeping `trackOf`/`setTrack` and dressing up the UI.** It would have left the one component with private doc
methods, which is the thing Kodjo was pointing at even where he was describing the tab.
