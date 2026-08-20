# ADR 0039 — `Visual` splits into `Mesh` and `Renderer`

Status: accepted. Corrects the visual half of ADR 0035's component set.

## Context

Kodjo: *"material override is a component while the component should be material — pretty much all game objects
with a mesh should have one. Same for mesh. It's very similar to what's in Unity."*

Two things were wrong, and they were the same thing twice.

**`MaterialOverride` was named as an exception to a rule that did not exist.** It was the only component with
"material" in its name, and it was *not* how an object normally got one — `Visual.material` was. So the panel
read as though a material were something you occasionally override, when in fact almost every object has one.
There was nothing called `Material` or `Renderer` for an "override" to override.

**`Visual` bundled two unrelated decisions.** `source` (`'collider' | 'model'`), `model`, `material`. Geometry
and surface change on completely different schedules — you swap materials constantly and meshes rarely — and
the bundling forced a `source` enum to say which of its own fields mattered. ADR 0038 then had to invent a
`when` condition so that `model` would hide itself while `source` was `collider`: a mechanism to work around a
modelling mistake.

## Choice

Unity's split. `MeshFilter` says **what** shape; `MeshRenderer` says **that** it draws, and with what.

```ts
Mesh     { model: asset }      // geometry, when it is not the colliders
Renderer { material: asset }   // that this draws, and its surface
```

| has | draws |
|---|---|
| `Renderer`, no `Mesh` | every `Collider` on the node, each at its own centre — the greybox case, and most content |
| `Renderer` + `Mesh` | the mesh |
| `Mesh`, no `Renderer` | nothing — a `MeshFilter` with no `MeshRenderer` |
| neither | nothing |

**`source` is deleted.** Having a `Mesh` *is* the answer it gave. One less enum, one less conditional field,
and ADR 0038's `when` machinery loses its only user — it stays, because it is the right tool the moment a
component genuinely has a mode, but nothing in the built-ins needs it now.

**A `Mesh` whose `model` is empty falls back to the colliders**, which is the same fallback `source: 'model'`
with no asset already had.

**`MaterialOverride` keeps its name and its cascade**, and the name now tells the truth: there is a `Renderer`
for it to override. Kodjo confirmed keeping the one-click subtree restyle when the plan was approved (ADR 0035).

## Migration

Two passes now live in `packages/components/src/migrate.ts`, each skipping what it has already done.

Pass 2 is **node-to-node**, not a re-run of the legacy conversion, because by the time it was written the
files were already nodes and `default.json` had been edited in the editor since the previous commit.
Regenerating from the captured fixture would have thrown that work away.

- `source: 'collider'` → `Renderer { material }`
- `source: 'model'` with an asset → `Mesh { model }` then `Renderer { material }`, in that reading order:
  what it collides as, what it looks like, that it draws

**The `Renderer` inherits the old component's id**, and the `Mesh` takes a derived one. That is what keeps a
placement's material override pointing at the thing it was always about: `default.json`'s trampoline override
still names `c1` for its material and `c2` for its bumper power, unchanged.

**Verified the same way as before.** The equivalence pass loads every level from the captured pre-component
fixture through the old loader and through the new one and compares meshes in order, colliders, materials,
spawn, rules, wire indices and poses at seven clock times. It passed unmodified across this change, which is
what says the split is behaviour-preserving.

## Consequences

- **A greybox object stays at two sections** in the Inspector (Collider + Renderer). A model object goes from
  two to three. Most authored content is greybox, so the panel does not get worse — and the count went from 30
  rows to 18 in ADR 0038, so there is room.
- **`Renderer`, not `Material`.** The material is one *field* of a role that will grow shadow-casting and a
  render layer. Naming a component after one of its fields is precisely the mistake `MaterialOverride` was
  making, and there was no reason to repeat it while fixing it.
- **`ENGINE_COMPONENTS` is five**, so the built-in registry holds ten.
- **A mesh with no renderer is now expressible**, and it draws nothing. Under `Visual` that state did not exist.
- **Placing a model produces three components** (`Collider`, `Mesh`, `Renderer`), and they are added in that
  order because that is the order somebody reads them in.

## Rejected

**Naming it `Material`.** What Kodjo asked for, and what it holds today. Offered as the alternative and he
picked `Renderer` once the field-versus-role argument was on the table.

**Deleting `MaterialOverride` and doing subtree restyling by multi-selection instead.** The general answer, and
it would remove a component type — but the Inspector edits the primary of a selection only, so it would mean
building multi-edit first, and Kodjo had already asked to keep the one-click restyle.

**Keeping `source` and gating `model` with `when`.** What ADR 0038 shipped. It works, and it is a mechanism
compensating for two components wearing one name.
