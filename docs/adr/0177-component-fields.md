# ADR 0177 — Component fields, and reference fields as Unity has them

Status: accepted. Amends ADR 0176 (the ✕, one tile at a time) and ADR 0095 (Boss's `zone` names a node).

## Context

A parameter could point at an object (`nodeRef`) or an asset, not at a component. Unity has fields typed by a
component — `public BoxCollider zone` — which take a dragged object's component of that type, or a component
dragged by its header. Boss's zone was an object field whose box collider it looked up by itself. Kodjo: match Unity
as closely as possible, even where that undoes his earlier calls.

## Decision

- **`componentRef`**, `{ kind: 'componentRef', of: <type> }`: the value is `{ node, component }` — the node by id,
  found in the reference's scope as a `nodeRef` is, and the component by its id, so an object with two Colliders is
  not ambiguous. Scripts read it with `self.findComponent(ref, def)`: the node, the typed params and, for a Collider,
  its world-scaled shape. A copy re-ids nodes, not components, so a re-id moves only the node half (`retargetRef`).
- **The field** is the reference field: `Zone (Collider)`, the ordinal where there are several. A Hierarchy row gives
  its first component of the type, as Unity's `GetComponent` does (Kodjo first chose a menu for several, then
  Unity's rule); a card dragged by its header — Unity's dragged component header — gives exactly itself, a prefab's
  component included. On an object field a card gives its object.
- **Unity's handling on every reference field**: no ✕ — Delete or Backspace on the focused field clears it, or None
  in the picker; a press pings, a double-click opens (the object selected, the asset shown); of several tiles dropped,
  the first; `None (Material)`.
- **Boss's `zone` is a Collider field** (Kodjo). Its six zones in the content — four Keyboard levels, the Shared Boss
  prefab — are converted once on the box by `deploy/editor/migrate-component-refs.sh`, to the node's first enabled box
  Collider: the one the old read took, so every Boss chases as it did. Until that has run and the content is merged
  into master, the code reads the old shape, a bare node id, as the node's first of the type (the way ADR 0153 bridged
  its fold); then that read goes.

## Rejected

- **A menu when a dropped object has several of the type.** Unity takes the first; a header drag picks one exactly.
- **Storing the node and the type only.** A repeatable component — two Colliders — would be ambiguous.
- **A `where` filter on the field** (only box Colliders for Boss). The field takes a Collider, as Unity's
  `BoxCollider` field would be the type itself; a zone that is not a box sends the Boss home, as it did.
