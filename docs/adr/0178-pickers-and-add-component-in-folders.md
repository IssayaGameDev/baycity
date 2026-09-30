# ADR 0178 — Pickers and Add Component in folders

Status: accepted. Amends ADR 0176's flat picker list.

## Context

A reference field's picker was a flat list: in a level with ten walls it read `Wall (Collider)` ten times, with no
way to tell them apart. Add Component was a flat menu of every type. Kodjo: both could be better with folders.

## Decision

- **One searchable tree** (`treePicker.ts`) behind both: folders that open and shut, what can be picked inside them,
  and a search that lists every match flat with where it is in grey; Enter takes the first.
- **The reference field's picker is the Hierarchy's tree** for an object or a component (Kodjo's pick over a flat
  list with paths): only the branches holding something that fits, the way to the current value open. An object
  with one component of the type is itself the row; one with several lists them. An asset field's is the Project
  window's folders, the built-in shapes in *Built-in*.
- **Add Component is Unity's**: a search over folders — Physics, Rendering, Gameplay, Animation (Kodjo: *Animation*),
  then a game's own under the game's name. A component declares its folder (`menu`), as Unity's
  `AddComponentMenu` does. The Hierarchy's *Add component* submenu groups the same way.

| folder | components |
|---|---|
| Physics | Collider |
| Rendering | Mesh Renderer, MaterialOverride, Light |
| Gameplay | Spawn, Checkpoint, Hazard, Bumper, Boss |
| Animation | Sequence |
| the game's name | its own |

## Rejected

- **A flat list with each row's path.** Readable, but long; the tree is the folders asked for, and a search still
  gives the flat list with paths.
- **Folders from a table in the editor.** The component knows where it belongs, as in Unity; a table drifts from
  the components it lists.
