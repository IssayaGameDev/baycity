# ADR 0184 — Following takes their selection and their Motion preview

Status: accepted. Extends ADR 0155 (Focus and Follow). Kodjo's calls: selection and Motion now, the open file
later; a selection of your own ends the follow.

## Context

Following copied the leader's camera and projection only. What they selected, and whether their Motion preview
ran, stayed yours, so a follower saw their view of the level but not what they were working on.

## Decision

- **Selection.** The follower's selection is what the leader holds (ADR 0158), taken when the follow starts and
  whenever the room's holds change, once a frame, never in the middle of a drag. The holds are already on the
  room's stream, so nothing new is sent. Kept in the order they were taken, so the leader's primary is the
  follower's: the same gizmo, the same Inspector.
- **Motion.** The leader sends its Motion clock when its preview starts or stops, and to a new follower; the
  follower's clock runs on from it. Passed on down a chain of follows.
- **What ends it.** As with the camera, anything of your own: a selection (a click on an object, a row, nothing,
  an asset; Escape; Select all) or a press of Motion. Restoring a selection after a rebuild is not one.

## Rejected

- **A selection of your own that the leader's next one replaces.** Kodjo's call: what you just picked would be
  wiped out.
- **Following into another level or a prefab.** Each is its own room and a follower sees only its own room's
  people, so the leader would have to say where it is going. Its own job.
- **A Motion clock sent continuously.** Both clocks run on wall time from the same start; a start or a stop is
  all that changes it.
