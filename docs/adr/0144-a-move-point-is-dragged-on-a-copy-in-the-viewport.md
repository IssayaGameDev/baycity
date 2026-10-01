# ADR 0144 — A move point is dragged on a copy in the viewport

Status: accepted. The viewport half of [ADR 0143](0143-a-sequence-is-edited-as-boxes-in-the-inspector.md).
**Its corner snap superseded by ADR 0179**: the copy snaps as any move does.
Kodjo's picks: a move's point is typed **or dragged**, and the route shows for the **selected object only**.

## Context

A move's point is typed in the Inspector. For the ball rolling down a slope, the number is whatever puts it on
the slope, which is found by looking, not by arithmetic. ADR 0103 removed the keyframe handles for leaving
numbers like 10.1 and 10.2; snapping (ADR 0114) did not exist then.

## Decision

**While a move step is open in the Inspector, a see-through copy of its target stands at its point, with move
handles** (`pointTool.ts`). Dragging the copy writes the step's `to` through `Doc.setSequenceStages`, one
history entry per drag like any gizmo drag, and the Inspector's numbers follow. Snapping puts the **copy's
minimum corner** on the grid, as any move's (ADR 0117, `cornerSnapOf` shared with `gizmoTool.ts`).

| | |
| --- | --- |
| which step | the open move step opened last, of the selected object's sequences, in a section that is open |
| the object's own gizmo | gives way while a point is open, as it does for Face (ADR 0119) |
| the copy | the target's own meshes and its children's, one flat see-through colour; no lights, lines or cells |
| the route | for **one** selected object: a line from where it was placed through its move points in play order, a dot numbered in that order at each; one line per sequence that moves it — its own and its parent's aimed at it (`Doc.routesAt`) |
| on top | line and dots ignore depth, so a route behind a wall still reads; the copy does not |
| colour | one warm colour for all three, against the surface cells' blue |

**A point is where the game puts the target.** `pointToWorld` / `worldToPoint` (`sequencePoints.ts`) are
`combineSequences`' framing composed with the frame tree: `object` axes turn the point by the target's placed
world rotation, `level` axes do not turn it at all, and the parent's scale cancels. Tested against that
composition under a turned, stretched parent. The target's place is its parent's group as posed now times its
authored transform, so a copy and a route follow a parent the Motion preview moves.

**Unpickable by where it lives**: its own group outside the item groups, which every click raycasts and
nothing else does.

## Rejected

- **Two gizmos at once**, the object's and the copy's. A new move step is a metre up, well inside the handles'
  size, and two `TransformControls` both claim a press on overlapping handles.
- **A copy per open move step.** Several open points and one set of handles; the others would be decoration.
- **Routes for a whole multi-selection.** Kodjo's pick was the selected object; the Inspector edits stages only
  for one, too.
- **The route in the level's frame from the authored transforms alone.** Right with Motion stopped, wrong the
  moment a parent's own sequence moves it.
