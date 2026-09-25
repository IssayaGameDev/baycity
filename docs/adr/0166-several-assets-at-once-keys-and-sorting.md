# ADR 0166 — Several assets at once, Unity's keys, and a sort in the Project window

Status: accepted.

## Context

The Project window (ADR 0163) took one tile at a time, by the pointer only, in name order.

## Decision

Kodjo's calls:

| # | Decision |
| --- | --- |
| 1 | **Ctrl+click** adds or takes away a tile, **Shift+click** selects a range, as in the Hierarchy |
| 2 | Several selected **drag into a folder** and **delete** together; each is refused, with why, if any one of them cannot go, as one is; a delete **asks once** for all |
| 3 | **Unity's keys** while the window has the focus: arrows move the selection, Enter opens (a folder or a prefab), Backspace goes up, Delete deletes, F2 renames, Ctrl+A selects all |
| 4 | A **sort button** in the top bar: name, kind, date changed; folders always first |

All or none is the server's: several moves or deletes come as one request, every one checked — locks, a name already
taken, a move into another library (judged together, so a prefab and the material it uses may cross as one) —
before any is done. The date is the file's, sent with the asset list (ADR 0165). The Inspector shows the last one
picked; a drag into the viewport places one at a time (ADR 0164).

## Rejected

- **Drag only, deletes one at a time.** Emptying a folder of a dozen files was a dozen questions.
- **Arrows and Enter only.** The rest would stay behind a right-click.
- **Name and kind only.** No server addition, but nothing finds what was just uploaded.
