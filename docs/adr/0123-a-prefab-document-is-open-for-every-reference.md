# ADR 0123 — A prefab document is open for every reference

Status: accepted. Restores an invariant ADR 0091 stated and only half kept.

## Context

*Apply to prefab* answered `404 Not Found` on `POST /api/live/prefab/<assetId>/ops`, and nothing happened.

`live.apply` begins with `must(name)`, which throws 404 *"is not open"*. Applying from a level is a write to a
room this tab is not in, and the design allows for that: a prefab document "stays open while any level
references it", and `editorOf` deliberately accepts a connection found in one of the prefab's `dependents`.

What opens the document and records the dependency is `hydrate`, and it only ran for references that needed
**filling**:

```ts
if (level.prefabs?.[id] !== undefined) continue // already resolvable
```

So a level carrying its own inline definition — which `stripHydrated` deliberately preserves, for content the
migration has not reached — resolved every placement from its own table, asked the store for nothing, and left
the prefab's document shut. Every visible thing worked: the placement drew, overrides recorded, the Inspector
listed them. Only the write to the other room failed, and only for those levels.

Found on `content/keyboard/levels/Roblox.level.json`, which carries inline definitions for three prefabs.

## Decision

**`hydrate` opens the document and records the dependency for every prefab the level references**, not only
the ones whose definition it had to fetch.

```ts
for (const id of hydratePrefabs(d.level, { root: (id) => attach(id)?.level.nodes[0] }).filled) d.hydrated.push(id)
for (const id of prefabRefsIn(d.level)) attach(id)
```

The invariant is about the **reference**, so it has to hold however that reference happens to resolve. Fixing
it here rather than at `apply` leaves `must` and `editorOf` untouched: the connection check still requires a
live room that depends on this prefab, which is the property worth keeping.

**The inline definition is left exactly as it was.** Opening the document neither adopts the level's copy nor
strips it, so the file round-trips unchanged and `stripHydrated`'s promise holds. That such a level keeps a
frozen copy which no longer follows the prefab is a separate defect, about how those definitions came to be
written, and is not fixed here.

## Rejected

- **`open(name)` instead of `must(name)` in `apply`.** Treats the symptom, and then `editorOf` fails second
  because a document opened on demand has no dependents — so the connection check would have to be widened to
  "any live room of this user", which is the part actually worth keeping strict.
- **Adopt the prefab document's root over the level's inline table.** It is the right end state and it is a
  content change: it silently replaces an author's copy with the shared object. Separate decision.
- **Open every prefab in the store when any level opens.** One object per prefab is the point, not one
  document per asset regardless of use.
