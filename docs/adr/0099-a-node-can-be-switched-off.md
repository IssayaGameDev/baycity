# ADR 0099 — A node can be switched off, and its subtree with it

Status: accepted. Extends the component-level `enabled` (ADR 0035) to the node.

## Context

Kodjo asked for Unity's active checkbox: disable a game object in the editor and have its children go with it.

`enabled` existed only on a `ComponentData`, and in an override keyed by component id. A node had no such
field, so there was no way to take an object out of a level without deleting it.

## Decision

**`Node.enabled`**, absent meaning enabled — the same convention a component already uses, so no existing
level changes and there is one shape on disk (switching a node back on *deletes* the field rather than writing
`true`).

Kodjo's three calls:

- **It is level data, not a view setting.** A disabled node is not built in the editor, the play-test or the
  shipped game. That is what lets half-built content or an alternate route be parked in a level.
- **Hidden in the viewport, not ghosted.** Exactly Unity: gone from the scene view, and the Hierarchy row is
  the way back to it.
- **A placement can switch off a part it inherited.** `NodeOverride.nodeEnabled`, so one placement of a
  platform prefab can drop its spikes while every other placement keeps them. Consistent with the component
  checkbox, which already worked that way.

**It cascades by omission, not by copying.** A disabled node is never descended into, so a child's own flag is
simply not consulted, and switching the parent back on restores whatever the children said. Nothing writes a
derived value onto a child, so there is no state to get out of step.

## Where it is honoured

| Place | How |
| --- | --- |
| `effectiveNode` | `Resolved.enabled` — the placement's own answer first, then the prefab root's, so a prefab disabled at its root is off wherever it is placed |
| `bakeOverrides` | applies `nodeEnabled` to an inherited node |
| `instantiateLevel` | returns before `makeFrame`, so there is no body, no visual, no light, no component and no `baseIndex` |
| `walkNodes` | returns before visiting, so the fingerprint measures what the level actually draws |
| `validateLevel` | boolean or absent, on the node and on the override |
| ops | `setNodeEnabled` on an own node, `setOverrideNodeEnabled` on an inherited one (`null` clears) |
| editor viewport | **builds no meshes** for it |
| Hierarchy | a checkbox per row, left of the twist; the row's name dims and italicises |

`touchedRefs` reports the **whole subtree** for `setNodeEnabled`, as `removeNode` does: switching a node off
takes everything under it out of the level, so a hold anywhere in it has to be respected.

## The two traps

**No meshes, rather than an invisible group.** Three does not skip invisible objects when raycasting
(`Raycaster.js` has no `visible` check), so `visible = false` would have left a disabled object *clickable in
the viewport* — selecting something you cannot see. Building nothing also matches what the loader does, so the
two halves agree. The group itself is still created, so document indices, Hierarchy selection and the gizmo
keep working: a disabled object can still be moved, just not seen.

**`baseIndex` shifts.** It is assigned in instance order at load and goes on the wire (ADR 0021), so skipping a
node renumbers every clock-driven piece after it. That is safe *only* because enabled-ness is level data read
from one file by every client. Had this been a per-client view setting, two clients would have disagreed about
which platform a rider was standing on. Asserted in a test, so the reasoning is not just written down.

## Rejected

- **Editor-only hiding.** Cheaper, and then it is not "disabled" — it cannot park content, and the checkbox
  would lie about what the level contains.
- **Ghosting it in the viewport**, dim and still selectable. Offered; Kodjo chose Unity's behaviour. The cost
  is that a large disabled area is invisible and easy to forget, which the Hierarchy's dimmed row mitigates.
- **A key in the override's `enabled` map.** That map is keyed by component id and a node is not a component —
  the same reason `enabled` is not folded into `params`.
- **Writing `enabled: true` when switching back on.** Two shapes meaning one thing, and a diff on every
  toggle.
- **Copying the flag down onto children.** Then re-enabling a parent could not know which children were off
  on their own account.
