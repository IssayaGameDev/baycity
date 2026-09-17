# ADR 0122 — Revert and Apply have two scopes

Status: accepted. Fixes a gap left by ADR 0091's per-piece overrides.

## Context

An override is stored on the **placement**, keyed by the inherited node it changes (ADR 0091). So `kindOf` is
`'inherited'` and `overridesOf` non-empty only for a **piece** inside a placement.

Revert and Apply asked exactly the clicked node:

```ts
enabled: inherited && doc.overridesOf(index).length > 0
```

The placement **root** carries no override of its own and never will — its transform is its own, and an
override is by definition a difference from the prefab. So right-clicking the prefab object offered both
entries permanently greyed, reading "nothing overridden here", however much had been changed inside it. The
Inspector had the same hole from the other direction: `addOverrideStrip` returned early unless the selection
was inherited, so selecting the prefab object said nothing about overrides at all.

Kodjo hit this on both. It is the first place an author looks after editing inside a prefab, and it is where
Unity puts Revert All / Apply All.

## Decision

**The pair has two scopes: a piece, and the whole instance.** On a piece, unchanged. On a placement root, it
acts over every piece the placement owns.

Three additions to `Doc`, so the arithmetic is in one tested place rather than in two panels:

| | |
|---|---|
| `placementOverrides(i)` | every piece of the placement carrying an override, and what each overrides. Only pieces owned by **this** placement: a prefab containing a placement of another has pieces that belong to the inner one |
| `revertPlacement(i)` | drops them all in **one batch** — one Ctrl+Z, one message to the room, rather than a dozen |
| `placementOverrideOps(i)` | merges them into one batch for the prefab's own document, so a partial failure cannot leave half the instance applied |

**The wording carries the scope**, because the two buttons do very different amounts and a menu entry that
reads the same at both scopes is how you apply more than you meant to:

| Where | Menu | Inspector strip |
|---|---|---|
| a piece | `Revert to prefab` / `Apply to prefab` | `N overrides` · Revert all · Apply |
| the root | `Revert all to prefab` / `Apply all to prefab`, with the count on the right (`2 objects`, `3 changes`) | `3 overrides on 2 objects` · Revert all · Apply all |

The disabled reason changed too. "Nothing overridden here" was true of the node and useless to the person;
it is now "this prefab matches — nothing has been changed inside it" on the root and "this object matches the
prefab" on a piece.

**No confirm on Apply all**, matching the per-piece Apply. It writes to a shared definition every level
follows, which is worth a dialogue in principle — but adding one at only one of the two scopes is worse than
having none, and the count in the label plus the status line afterwards is what makes it legible. Revisit
together if at all.

## Rejected

- **Aggregate in the panels.** Each would walk the subtree itself, and the menu and the strip would be two
  copies of "what has changed in here" — the class of fault ADR 0113, 0114, 0117, 0119 and 0120 were each an
  instance of.
- **One op per piece for the revert.** A dozen undo entries for one gesture, and a dozen messages to the room.
- **Store an override on the placement root** so the existing code would find it. It would be an override of
  nothing: the root's transform is its own, and the prefab has no opinion about where a placement sits.
- **Leave it and fix the tooltip** to point at the pieces. Cheapest, and it teaches the author to do by hand
  what the tool should do — which is how ADR 0118 started.
