# ADR 0220 — A reference follows a move, and an added child lives in its placement

Status: accepted. Amends ADR 0219. Kodjo's call: fix what it left out — a piece dragged out of its placement.

## Context

ADR 0219 kept a reference naming its object through unlink, Save as prefab and duplicate. Dragging a piece out
(ADR 0133) lands a copy with fresh ids and records the piece removed, so a reference to it showed missing. Fixing it
showed a second gap: the loader builds a placement's resolved children — what it **added** under its root or a piece
too — in the scope it opens, while the editor treated an added child as the level's. A level reference to one by its
plain id read as found in the editor and was nothing in the game; moving an own node into a record did the same.

## Decision

- **The editor's scopes are the loader's** (`homesOf`): a piece lives in its owner, an added child in the placement
  holding its record, anything else where its parent does. From outside a placement, what lives in it is named
  `<placement>/<id>`; the loader already found an added child that way.
- **A move re-points what named the moved subtree from outside it**, in the same batch (`followMove`): a piece's
  copy by its new id; an own node by its own id, named from where each reference is by where it will live. A moved
  placement's pieces stay where they are.

## Rejected

- **Making the loader put added children in the level's scope**: a placement's added child is part of that placement
  — copied with it, removed with it — and a prefab's own references reach it there.
