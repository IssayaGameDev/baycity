# ADR 0176 — Reference fields take drops, and a press that drags selects nothing

Status: accepted. Amends ADR 0134 (a press defers only on a multi-selection) and stage C4's dropdown for `nodeRef`.

## Context

A parameter that points at something — an object (`nodeRef`), a material or a model (`asset`), a material's texture
slot — was a dropdown. Unity's way is to drag the object or the asset onto the field. Two things stood in the way:
pressing a Hierarchy row selected it at once, and starting a drag on a Project tile selected that asset, so either
swapped the Inspector away from the field being filled.

## Decision

- **A reference field replaces the dropdown** (Kodjo: Unity-style): the name of what it points at, ✕ to clear, and a
  picker — a search over the same choices the dropdown had, built-in shapes included. A press on the name pings what
  it points at (the row flashed, the tile shown) without selecting it.
- **It takes drops**: a Hierarchy row on an object field, a Project tile on an asset field or a texture slot (Kodjo:
  texture slots too). It lights for what fits and greys with why for what does not, by the rules the pickers already
  list by: an object's reach (`nodeChoices`, asked by index as `refTo`), an asset's kind and library (ADR 0161).
- **A press that becomes a drag selects nothing** (Kodjo): every plain press on a Hierarchy row waits for the click,
  and a drag of a Project tile that is not selected carries it alone without selecting it.
- The Hierarchy's drag is pointer events (ADR 0150), so it asks the field under the pointer; the Project window's is
  the browser's, whose payload cannot be read before the drop, so it reports what it carries to the editor.

## Rejected

- **Drag only, no picker.** Built-in shapes are not in the Project window, and a far object would need scrolling to.
- **An Inspector lock** to pin it while dragging from elsewhere. A button to press every time, for what not
  selecting on a drag gives for nothing.
- **Component references** (a field that takes an object's component of a type). Wanted, and next; not in this.
