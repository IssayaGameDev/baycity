# PLAN — Component system (`packages/components`)

A Unity-style component system: a scene node holds a **list** of components, each a TypeScript
definition with declared parameters and lifecycle hooks. Components are added and removed per node in
the editor, their parameters generated into the Inspector from the declaration.

This replaces four fixed optional fields (`Piece.collider`, `.visual`, `.trigger`, `.behavior`) and the
two node types (`Piece`, `PrefabInstance`) with one node type and one registry.

Zero new external dependencies. `packages/components` is a new internal package.

## The one architectural constraint, and how it is answered

Motion today is `pose = f(syncedTime)` (ADR 0013/0021), so nothing about moving objects is networked and
any client computes the same pose. A lifecycle hook that accumulates state breaks that equality — unless
the accumulation is **deterministic**. Then every client folds the same ticks from the same start and
still agrees, with still zero traffic.

So the answer is determinism, not synchronization. Three classes, and the boundary is enforced by what
`Ctx` exposes rather than by a rule in a document:

| class | state | agreement | cost |
| --- | --- | --- | --- |
| **pure** | none, or a function of `tick` | automatic | free |
| **local** | accumulates; affects only this client's own character or view | not needed | free |
| **shared** | accumulates; every client must agree on it | needs an owner + sync | Stage C5 |

Worth knowing before this starts: **every gameplay rule that exists today is local.** Checkpoint, goal,
hazard and bumper all react to *my* contact and change *my* character. That is why they cost nothing to
run as components with real code. The wall is only hit by a component that changes shared world state
(a door that stays open, a button, a pushable crate), and `Ctx` cannot express that until C5.

Determinism rules, enforced by the API:

- No wall clock. `ctx.timeMs` is the synced clock; `Date.now()` is unreachable from a component.
- No `Math.random()`. `ctx.random()` is seeded from `(tick, nodeId, componentIndex)`.
- Fixed step only. No render-step hook in C2, so nothing gameplay-facing can depend on frame rate.
- No frame-order luck: execution order is authored data (below), not registration order.

## Node

One type replaces `Piece` and `PrefabInstance`. A prefab is a node tree; a level is a node tree whose
children may reference prefabs.

```ts
interface Node {
  id: string                        // stable, minted on demand (generalises Piece.id, ADR 0033)
  name?: string
  transform: Transform
  components: ComponentData[]
  children?: Node[]
  prefab?: string                   // set on a node that references a shared definition
  overrides?: Record<string, NodeOverride>   // keyed by the referenced tree's node ids
}

interface ComponentData {
  id: string                        // stable, for overrides
  type: string                      // registry key
  params: Record<string, unknown>   // validated against the declaration; absent keys take defaults
  enabled?: boolean                 // absent = true
}
```

Consequences that are the point:

- A node can be a checkpoint **and** a bumper. Impossible today (one `trigger` field).
- A node can hold two colliders and one bumper. Both bounce.
- A collider is optional, so a visual with no collision and an empty grouping node are both expressible.
- `Marker` dies. A checkpoint marker with a radius becomes a ball `Collider` plus a `Checkpoint`. Spawn
  becomes a `Spawn` component. One concept instead of two half-concepts.
- The piece-versus-object split dies with it, and with it the whole class of bug ADR 0033 was written
  about.

## Defining a component

Parameters are declared, not reflected: TypeScript types are erased at runtime, and the declaration is
what the Inspector, the validator, the defaults and the serializer all read. One declaration, five uses.

```ts
export const Bumper = defineComponent({
  type: 'Bumper',
  params: {
    power: { kind: 'number', default: 26, min: 1, max: 60, label: 'launch (m/s)' },
  },
  onContact: (self, ctx, hit) => {
    if (hit.character !== undefined) hit.character.launch = self.params.power
  },
})
```

`self.params.power` is `number` with no cast, via a mapped type over the declaration:

```ts
type ParamSpec =
  | { kind: 'number'; default: number; min?: number; max?: number; step?: number; label?: string }
  | { kind: 'bool'; default: boolean; label?: string }
  | { kind: 'string'; default: string; label?: string }
  | { kind: 'enum'; options: readonly string[]; default: string; label?: string }
  | { kind: 'vec3'; default: Vec3; label?: string }
  | { kind: 'asset'; of: 'material' | 'model'; default: string; label?: string }
  | { kind: 'nodeRef'; label?: string }                       // C4
  | { kind: 'keys'; label?: string }                          // the existing timeline editor

type Params<D> = { [K in keyof D]: ValueOf<D[K]> }
```

**Authored params and runtime state are separate.** Unity conflates them (public fields serialize,
private do not), which is exactly what makes Unity's saved scenes surprising. Here `params` is authored
and serialized; `init` returns runtime state that never touches JSON. That split is also what makes the
determinism story checkable: runtime state is the only thing that has to be derivable.

## Lifecycle

```ts
onAttach?  (self, ctx)              // once at instantiate. Unity's Awake + Start, merged.
onFixedUpdate? (self, ctx)          // every sim tick, fixed dt. Unity's FixedUpdate.
onContact? (self, ctx, hit)         // a collider on this node was touched. Unity's OnCollision*.
onDetach?  (self, ctx)              // teardown.
```

Deliberately absent: coroutines, `OnGUI`, per-frame `Update` (C2 is fixed-step only, so gameplay cannot
depend on frame rate), and `SendMessage`-style dispatch by string, which is unvalidatable.

`hit` carries the collider handle, the node, and the local character when it was the toucher. **It
carries no contact normal**: `body.collisions()` does not report one, so "launch along the surface you
hit" is unavailable until the physics layer exposes it. Known gap, not a blocker for anything authored
today.

## Ctx

The context object is the enforcement point, so what it withholds matters as much as what it offers.

Offers: `tick`, `dt`, `timeMs` (synced), `random()` (seeded), `node` (transform read/write — the
transform is derived every tick, so writing it is safe), `get(Def)` (Unity's `GetComponent`, this node
only), `character` (the local character).

Withholds: wall clock, `Math.random`, the network, the DOM, other players' characters, and any mutation
of another node's persistent state. The last one is the shared-state boundary and it stays closed.

## Execution order

Depth-first walk of the node tree, then component array order within a node. `order?: number` on a
definition breaks ties across nodes for the rare case that needs it. Deterministic because the tree order
is authored data. Unity leaves default order effectively undefined and everybody has been bitten by it;
being explicit is strictly better and costs one field.

## Prefab overrides, including structural

ADR 0033 recorded structural overrides as unsupported. A component system makes them mandatory, since
"this one placement also has a Bumper" is the ordinary case.

```ts
interface NodeOverride {
  transform?: Transform
  name?: string
  params?: Record<string, Record<string, unknown>>   // componentId -> partial params
  added?: ComponentData[]
  removed?: string[]                                  // componentIds
}
```

Revert works at three levels: one field, one component, the whole node. Apply-to-prefab likewise.

## Migration

Mechanical and scriptable. Content on disk is rewritten once, and the migration is verified the way the
track migration was: instantiate old and new, compare the world pose-for-pose at several times.

| today | becomes |
| --- | --- |
| `Piece.collider` | `Collider { shape, ... }` |
| `Piece.visual` primitive | `Visual { source: 'collider', material }` |
| `Piece.visual` model | `Visual { source: 'model', model, material }` |
| `Piece.trigger` checkpoint/goal/hazard | `Checkpoint {}` / `Goal {}` / `Hazard {}` |
| `Piece.trigger` bumper | `Bumper { power }` |
| `Piece.behavior` / `PrefabInstance.behavior` track | `Track { keys, loop, phaseMs }` |
| `Marker` spawn | `Spawn {}` on a node |
| `Marker` checkpoint/goal/hazard (has a radius) | ball `Collider` + the rule component |
| `PrefabInstance.material` | open question 1 below |

## Status

**C1, C2, C3 and C4 are built.** ADR 0035 records the schema and the migration; ADR 0036 records the runtime
and references. C5 is not started and needs Kodjo's decision.

Two things went differently from the plan below, both for the better:

- **C3 landed with C1.** Structural overrides were not a later stage: the migration needed `removed` on day
  one, because `trigger: { kind: 'none' }` and `behavior: { kind: 'static' }` are removals once a rule is a
  component.
- **`Track` kept no hook in C2.** The loader already evaluates it as a pure function of the synced clock, which
  is strictly better than an accumulating hook. `Goal` has none either, because no goal rule exists to write.

## Stages (each ends runnable, tests green, one commit after validation)

**C1 — node, registry, declared params. No lifecycle.** *Done.*
One `Node` type. `Collider`, `Visual`, `Spawn` as components. Registry, generated Inspector, add/remove
component UI, component reorder, copy/paste. Migration of all 6 levels and every prefab. Loader reads
components. Gameplay rules still read as data by the mode, exactly as today — so the game does not change
behaviour in this stage, which is what makes the migration checkable.

**C2 — lifecycle, and the rules become code.** *Done.*
`onAttach` / `onFixedUpdate` / `onContact` / `onDetach`, run from the sim's fixed step. `Bumper`,
`Checkpoint`, `Goal`, `Hazard`, `Track` become real components, and the parkour mode's special-casing of
each is deleted. This is the stage where it stops being a schema and starts being a component system.

**C3 — structural overrides.** *Done, with C1.* Added/removed components per placement. Three-level revert and apply.

**C4 — node references.** *Done.* `nodeRef` params with an Inspector picker. The hard part is a reference stored
*inside* a prefab, which must be relative to the prefab and remapped per instance; a reference stored in
a level is an absolute node id. Nothing authored needs this yet, which is why it is last.

**C5 — shared mutable state. Not planned, needs a decision.** Doors that stay open, buttons, dynamic
rigid bodies. Requires an authority and a sync channel, i.e. a netcode milestone rather than a component.
Dynamic rigid bodies are explicitly out of scope for C1–C4 (Kodjo, this session).

## Tests that carry the weight

- **Determinism**: instantiate a level twice, fold N ticks with identical inputs, assert identical state
  hashes. The one test this whole design rests on.
- **Migration equivalence**: old content and migrated content produce the same world at t = 0, 250, 500,
  1000 ms. Same technique that caught nothing wrong in the track migration and would have caught plenty.
- **Param round-trip**: declaration defaults, JSON write, validate, read back.
- **Override resolution**: param, added, removed, and all three reverts.
- **Execution order stability**: a shuffled registry does not change the order components run in.

## Rejected

**Runtime-compiled component scripts** (esbuild-wasm in the browser, hot reload). More Unity-like, and it
is what a plugin platform would need. Rejected: it adds a compiler dependency, a sandbox question, and a
source-map story, for an audience of one author who has the repo open in an editor already. Definitions
compile in with the app; adding a component is a rebuild.

**Bumper holding a reference to its collider.** Not Unity's model: contact is delivered to the node and
every component on it hears about it, no wiring. Also the version with a pointer has a dangling-pointer
state that the version without cannot have.

**Keeping the trigger field and adding a parameter table** (the earlier proposal in this session). It
removes the copy-paste but leaves one rule per node, keeps the piece/instance split, and would be thrown
away by C1. Rejected as a rename.

**Per-frame `Update` in C2.** Gameplay that reads frame time desyncs by construction, and the failure is
invisible on one machine. A render-step hook for purely cosmetic components can be added later, gated so
it cannot touch the character.

## Open design questions (Kodjo)

All four were answered by "go", taking the recommendations: the resurface-everything material is kept as a
`MaterialOverride` component, the strongest bumper wins, every component has an enabled checkbox, and a
cosmetic render-step hook is deferred.


1. **Instance-wide material.** `PrefabInstance.material` resurfaces every piece of a placement in one
   click. After migration each `Visual` carries its own. Keep a "resurface everything below me" mechanism
   (a `MaterialOverride` component that applies down the subtree), or drop it and set materials per node?
   *Recommend keeping it* — it is the fastest thing in the editor today.
2. **Two bumpers on one node.** Strongest wins (today's rule when several are touched at once), first
   one, or sum? *Recommend strongest wins*, unchanged from today.
3. **Enabled toggle per component.** Unity has one, it costs a field and a runtime check, and it is how
   you test a level without deleting things. *Recommend yes.*
4. **Cosmetic render-step components.** Out of C2 above. Wanted later for spin-the-coin visuals and
   similar, or is fixed-step enough for everything? *Recommend deferring* until something needs it.
