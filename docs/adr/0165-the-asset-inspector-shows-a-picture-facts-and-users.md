# ADR 0165 — The asset Inspector shows a picture, the facts, and who uses it

Status: accepted.

## Context

Clicking an asset showed its name, kind, path and id; a material also its fields. A texture, a sound or a font was
auditioned in a strip under the Project window's tiles. Nothing said how big a file was, what a prefab held, or
whether anything used an asset before it was moved or deleted.

## Decision

Kodjo's call, for every kind:

| Part | What |
| --- | --- |
| picture | **big, on top**: a render (prefab, model, material), the texture itself, a sound's player, a font's sample. The strip under the Project window's tiles went with it |
| facts | per kind: a texture's size in pixels; a prefab's parts and its components with how many; a model's triangles and meshes; a sound's length; and every file's size and when it last changed |
| used by | the levels and the other assets (prefabs, materials) using it, **directly or through another** (ADR 0161's usage); a level's line opens it, an asset's selects it and goes to it in the Project window |

The server says who uses what, reading every level and asset as it is now, open documents included, and sends each
file's size and date with the asset list.

## Rejected

- **Picture and facts only.** No server addition, but nothing to check before a move or a delete.
