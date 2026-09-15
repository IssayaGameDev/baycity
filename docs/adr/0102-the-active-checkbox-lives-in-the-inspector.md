# ADR 0102 — The active checkbox lives in the Inspector, not the Hierarchy

Status: accepted. Amends ADR 0099, which put it on the Hierarchy row.

## Context

ADR 0099 gave a node an `enabled` flag and put its checkbox on the Hierarchy row, left of the twist. Kodjo,
having used it: that is not where he wants it. Unity puts it in the Inspector's header, left of the name.

He is right about Unity, and the reason holds here too: the Hierarchy is for **finding and arranging** things,
and a column of checkboxes running down it competes with the names it exists to show.

## Decision

The checkbox moves to the Inspector's header, above the name field, with a line saying what it means — `in the
level`, `off — not in the level`, or `off — a parent is switched off`.

**The Hierarchy still dims a switched-off row.** That was never the complaint, it is how you see the state of
a whole tree at a glance, and Unity dims too. `Row.disabled` and `Row.disabledAbove` stay; only the control
went.

Still disabled as a control when an ancestor is off, for ADR 0099's reason: the node's own flag is not what is
keeping it out of the level then, and a checkbox that changes nothing visible is worse than none.

## Consequences

- `HierarchyHost.onSetEnabled` is gone; `InspectorHost.onSetEnabled` takes no index, because the Inspector
  already knows what is selected.
- The toggle is one click further away — you have to select the object first. Accepted: switching an object off
  is not a thing done in bulk down a list, and selecting it is how you were going to check what it was anyway.
- Nothing about the data, the ops or the loader changed. This is where a control sits.
