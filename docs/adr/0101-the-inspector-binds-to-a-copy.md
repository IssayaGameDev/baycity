# ADR 0101 — The Inspector binds to a deep copy, never to the document

Status: accepted, amended: the fields are ours and write new values ([ADR 0152](0152-the-inspector-is-cards-of-our-own-fields.md)); the copy stays, and the panel updates it as they write. A consequence of ADR 0033's deliberate object sharing meeting Tweakpane's write model.

## Context

Kodjo's kill plane read **8000 / 50 / 8000** in the Inspector and **800 / 0.5 / 80** in the game. The first
cause was ADR 0098 — the write never landed. But that alone does not explain why the *editor* showed the new
size at all, since nothing had been recorded anywhere.

It showed it because the drag had edited the prefab definition directly, in memory.

Four steps, each reasonable on its own:

1. `state = { ...defaults, ...view.params }` is a **shallow** copy, so `state.shape` *is* `view.params.shape`.
2. On an inherited component, `view.params` is the **prefab's own** `params`. `bakeOverrides` returns the
   prefab's objects untouched wherever no override changed them — deliberately, so that editing a shared
   definition is not a silent no-op (ADR 0033).
3. `dims = { ...shape }` is shallow again, so `dims.halfExtents` *is* the prefab's `halfExtents`.
4. Tweakpane writes **into** a bound object rather than replacing it: `writePoint3d` calls `writeProperty`,
   which does `valueObj[name] = value`.

So dragging half extents on one placement wrote into the prefab definition every frame, before any op existed.

## What it cost

Not the files. A prefab is only written through its own live room, and that room's copy comes from the server,
not from the browser — so the mutation was local and died on reload. An earlier reading of this, that a later
prefab edit would bake it to disk, was wrong.

What it did cost:

- **Every other placement of that prefab in the open level redrew** at the new size, because they all resolve
  from the same object, while only the one touched got an override. The viewport showed a size the level did
  not have.
- **Overrides compounded from a wrong baseline.** A second placement's slider started at the already-mutated
  number rather than the prefab's real one.

## Decision

**`boundState(defaults, params)`** — `structuredClone({ ...defaults, ...params })`. The widgets bind to
something that shares nothing with the document.

Exported and pure, so the invariant is testable without a DOM, which is how this codebase tests the parts of
its UI worth getting right. Reverting it to a spread makes three of its tests fail with Kodjo's exact numbers.

At the top level rather than at each widget: `state` aliases **every** nested value, so `center` and every
future `vec3` had the same hole, not only `shape`.

## Rejected

- **Deep-copying `dims` in the collider branch only.** Fixes the reported symptom and leaves `center` and the
  next vec3 parameter broken.
- **Stopping `bakeOverrides` returning the prefab's own objects.** That sharing is what makes editing a shared
  definition reach every placement without copying trees around, and ADR 0033 chose it on purpose. The reader
  copies; the resolver does not.
- **Reading values back out of the document after every change instead of binding.** Tweakpane's model is a
  bound object; fighting it means re-building the pane on every keystroke.
- **Freezing the resolved params.** Would turn this into a throw at the point of the drag, which is louder but
  still a crash in the middle of a gesture, and `structuredClone` costs nothing here.

## Consequences

- One deep copy per component section per Inspector rebuild. Params are small and JSON-shaped.
- `write()` now sends values from the copy, which is what the op should carry anyway.
- The Inspector can no longer show a value that exists nowhere in the document.
