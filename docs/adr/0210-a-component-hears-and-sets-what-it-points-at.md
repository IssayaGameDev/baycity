# ADR 0210 — A component hears the collider it points at, and sets the components it points at

Status: accepted. What Kodjo's Obstacle (ADR 0211) needs from the platform: a trigger on another node that reaches it,
and a Win pad and a sign whose values it sets.

## Context

A component could point at another (`componentRef`, ADR 0177) and read it, and nothing more. `onContact` reached only
the components on the node that owns the touched collider, and a collider with no rule-bearing component reports to
nobody. And a component had no way to put a value into another one — the pad's `wins`, the sign's text — so that the
game's rules and the editor read it there.

## Decision

- **`componentRef` with `contacts: true`** (to a Collider): a touch on that collider also runs the holder's
  `onContact`, `hit` naming that collider and its node. Resolved once when the runtime is built; once per handle per
  tick, even when the holder owns the collider too. `FoundComponent.colliderHandle` names the handle a hit carries.
- **`drives`** on a definition: `(params) → Drive[]` — `{ ref, type, params }`, set on the referenced component, over
  its own. Applied once the level is built (`drivesOf` + `drivenComponents`, `@mp/content`), so every reader of
  `WorldNode.components` and the text drawn see it; and by the editor's `textSpec`. An edit to a driving component
  redraws the whole scene (`Doc.drives`, `repaintFor`), as a sequence's does.
- `TypeInfo.get` carries `drives`, so the loader stays free of `@mp/components`.

## Rejected

- **Geometric membership, as the Boss's zone** (ADR 0095): box zones only, and tested at the capsule's centre once a
  tick, where a trigger is felt by the capsule in every slice (ADR 0208).
- **The editor writing the driven values into the content** (Unity's `OnValidate`): a write into another component, an
  override when that component is a prefab's, from a field edit, collaborative and undoable — for a value the level can
  derive as it loads.
- **The game patching what it drew at runtime**: the rules and the editor would read the old values.
