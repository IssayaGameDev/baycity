# ADR 0131 — A prefab's piece can be copied

Status: accepted. Pairs with [ADR 0130](0130-a-child-added-to-a-placement-can-be-applied.md): copying a piece
out and applying a child back in are the two halves of one workflow. Narrows
[ADR 0091](0091-a-level-references-a-prefab-by-id.md)'s rule that an inherited node cannot be edited here —
it still cannot, but a *copy* of one is not an edit.

## Context

Selecting an object inside a placed prefab and pressing Ctrl+C did nothing. `Doc.copy` returned `null` for an
inherited node and `copySelected` filtered the nulls out, so the clipboard was left as it was with no message.
Ctrl+D did nothing either, returning the same index. The Hierarchy menu greyed both, so the *menu* at least
said why; the shortcuts said nothing at all.

The refusal came from one rule applied too widely: an inherited node belongs to the prefab, so structural
operations on it are refused. That is right for delete, reorder and reparent — each would have to change the
prefab, or change it for one placement only. Copying changes nothing. The copy is a new, plain object.

Kodjo wanted the obvious thing, and with ADR 0130 in place it completes a workflow: copy a wall out of a
prefab, paste it back onto the placement, Apply, and the prefab has two walls.

## Decision

**Copy takes an inherited node's resolved view.** `bakeOverrides` already recurses, so the view *is* the whole
subtree with this placement's overrides applied — which is what was on screen and therefore what was copied.
Ids are not re-minted at copy time; `paste` does that, as it does for an own node.

**Paste puts it wherever you paste it.** Kodjo's call: once copied it is an ordinary object, and a special
rule sending it back to the placement it came from would be the only paste in the editor that chooses its own
parent.

**Duplicate puts the copy under the placement, as an added child** (ADR 0130). Its siblings are the prefab's,
so there is nowhere else this level can put one, and it is what Unity does with the same gesture. Apply then
carries it into the prefab.

**Delete, Cut, reorder, reparent and Create-child stay refused** on an inherited node. Each of them has to
change the prefab; copying does not.

## Limits

**Ctrl+X on a piece copies it and leaves it.** Cut is copy-then-delete, and the delete is still refused, so
the original stays. The Hierarchy menu greys Cut on a piece, so only the shortcut reaches this. Left rather
than special-cased: the honest alternative is a per-node partial cut, and a mixed selection would then cut
some of what was asked and not the rest. It did nothing at all before, so this is inert-to-acts-as-copy.

**Unity's Cut works**, because Unity has a fourth override kind this editor does not: a **removed
GameObject**. Deleting a prefab instance's child is recorded as an override on that instance, so it is gone
there and nowhere else, revertable and appliable like any other. That is the feature the Rejected list below
names, and it is what would make Cut whole.

## Rejected

- **A status line explaining the refusal** instead of allowing it. What was originally offered, and it
  answers the complaint with a sentence rather than the thing being asked for.
- **Pasting back into the source placement automatically.** Fewer steps for one case, and a rule that only
  this kind of clipboard item obeys.
- **Copying the *authored* piece rather than the resolved one**, so the copy matches the prefab instead of
  what is on screen. It would silently drop the overrides you can see, which is the surprise.
- **Allowing Delete on a piece**, recorded as a per-placement removal. That is a real feature — Unity has it,
  as a removed GameObject — and it is not this one.
