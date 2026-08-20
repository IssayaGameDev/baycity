# ADR 0036 — Components run, deterministically; references resolve per placement

Status: accepted, stages C2 and C4 of `PLAN-component-system.md`. Builds on ADR 0035, which made a node hold
components as data. This is what makes them *code*.

## Context

ADR 0035 landed a component system whose components could not do anything: the parkour mode still held a
branch per rule. Kodjo's ask was components authored in TypeScript with behaviour of their own, so this is the
half that matters to him.

The objection I raised twice, and it was real: motion in this stack is `pose = f(syncedTime)` (ADR 0013/0021),
which is why nothing about moving objects is networked. A lifecycle hook that accumulates state has no such
formula, and each client simulates its own world (ADR 0011) — so two players' worlds drift.

## Choice

### Determinism, not synchronization

A hook may accumulate state, provided **every client accumulates the same state**. `pose = f(t)` generalises
to a fold over ticks from a known start, and the traffic stays at zero.

That is a constraint on what a hook can *read*, so `Ctx` is where it is enforced rather than in a document:

| offered | withheld |
|---|---|
| `tick`, `timeMs` from the synced clock | the wall clock (`Date.now`, `performance.now`) |
| `random()`, seeded from `(tick, instance, call)` | `Math.random` |
| `character` — the local character's motion | any other player's character |
| `effects` — kill, progress | the network, the DOM, another node's persistent state |
| `self.get(def)`, `self.find(ref)` | — |

`random()` is a **hash** of its three inputs rather than a generator with hidden state, so the same
(tick, instance, call) yields the same number no matter what ran in between. A resume lands where a replay
does, which is asserted.

The three classes of component, and the one that is still closed:

- **pure** — no state, or a function of `tick`. Free.
- **local** — state affecting only this client's own character or view. Also free. **Every rule that exists
  today is local**: checkpoint, hazard and bumper all react to *my* contact and change *my* character, so
  nobody else has to agree. That is why C2 cost nothing in netcode.
- **shared** — state every client must agree on (a door that stays open, a button, a pushable crate). Needs an
  owner and a sync channel: a netcode milestone, not a component. `Ctx` gives no reach to do it, so the wall
  is in the API. That is C5, and Kodjo's to open.

### Four hooks, and no per-frame one

`onAttach`, `onFixedUpdate`, `onContact`, `onDetach`, plus an `init` that returns the instance's state.

No per-frame hook. Gameplay that reads frame time desyncs by construction and the failure is invisible on one
machine. A render-step hook for purely cosmetic components can be added later, gated so it cannot touch the
character.

Also deliberately absent: coroutines, `OnGUI`, and `SendMessage`-style dispatch by string name, which is
unvalidatable against a registry.

### Contact goes to the node

`onContact` fires when **any** collider on the same node is touched — Unity's model, and no wiring between a
rule and a collider. The alternative, a rule holding a pointer to its collider, has a dangling state this
cannot have. `Hit` carries no contact normal, because `CharacterBody.collisions()` does not report one; "launch
along the surface you hit" waits on the physics layer.

### `Track` keeps no hook

It is clock-driven and the loader's frame tree already evaluates it as `pose = f(t)`. A late joiner needs no
catch-up and a static subtree costs nothing. An accumulating hook would trade both away for nothing, so
motion stays where it is. `Goal` has no hook either: the mode has no goal rule, and writing one here would be
a design decision wearing an implementation's clothes.

### Order is authored data

Depth-first node order, then each node's component order. Unity leaves its default execution order effectively
undefined and everybody has been bitten by it; being explicit costs nothing and is what makes the determinism
test mean something. `onDetach` runs in reverse, so a child tears down before its parent.

### The mode supplies meaning, not mechanism

`Effects` is two calls: `kill()` and `progress(node)`. A rule says *what happened*; the mode decides what it
means — a ragdoll and a respawn here, a teleport in the editor's play-in-place. `progress` hands over the
**node**, not an index, because the ordered list a saved index means anything against belongs to the mode, and
it is built from **touchable** nodes only: a checkpoint nothing can reach is not a step in a progression.

`characterAccess(char)` adapts `CharacterState.launch` — the field `stepCharacter` consumes (ADR 0032) — and
**keeps the strongest request in a tick**, which is exactly the `Math.max` the mode used to do.

What went away: a checkpoint loop, a `Math.max` over bumper powers, and a hazard `Set`, all in the tick.
`modes/parkour/src/main.ts` no longer contains the word `Bumper`.

### Contact is not dispatched while dead

A corpse triggers nothing. Previously a dead body sliding over a checkpoint could bank it, which was a bug
rather than a decision.

### References resolve in a scope (C4)

A `nodeRef` parameter holds a node id. The problem is a reference authored **inside a prefab**: every
placement must resolve it to its own copy, and the id is the same string in all of them.

So the loader assigns a **scope**: `0` for the level, and one per placement for everything it inherited.
`findNode(from, id)` looks in `from`'s scope, then in the level. Both steps are needed — a reference authored
inside a prefab means "my copy of that node", and one set as an *override* on a placement is written in the
level and may name a level node. A placement registers under two ids: its own, to the level, and the prefab
root's, to a reference from inside.

`Resolved.inheritedCount` exists to draw that line: it says how many of a resolved node's children came from
the prefab, which is the run that gets the inner scope.

**The editor scopes the picker to match.** `nodeChoices` offers an own node only the level's own nodes, and a
node inside a prefab only its own siblings (plus the level, for an override). Offering more would let you
author a reference that dangles in every other level the prefab is used in.

**Duplicating remaps.** `reidSubtree` re-mints every id in a copied subtree and re-points any reference that
named one of them, override patches included. Without it a duplicate keeps pointing at the original — it looks
right and behaves as the original's shadow, which is the worst kind of wrong. Unity remaps the same way.

## Consequences

- **A node with no collider still runs.** `LoadedNodeLevel.allNodes` is every node in tree order; `nodes` stays
  the touchable ones. Two lists, because the mode indexes one and the runner walks the other.
- **A data-only component costs nothing.** `hasHooks` is checked once at attach, and a definition with no hooks
  never becomes an instance.
- **A disabled component does not run**, and is not instantiated at all.
- **`WorldNode.colliderHandles` exists**, the inverse of `nodeOf`. Found while writing the tests: Rapier packs
  a generation into a collider handle, so handles are **not** small sequential integers — the second fixed body
  in a world reads as `5e-324`. Nothing had assumed otherwise (they are only ever compared or used as keys),
  and it is a fresh reason the wire carries `baseIndex` instead (ADR 0021).
- **One cast in the whole system.** A hook is contravariant in the `self` it takes, so a registry of many
  definitions cannot hold them typed. `defineComponent` erases them once, at the only place that knows a
  definition's parameter and state types agree with its own hooks.
- **`self.state` is never serialized.** Authored parameters and runtime state are separate, unlike Unity, where
  a public field is both. That split is what makes the determinism claim checkable at all.
- **Play-in-place runs the real components**, so the editor's probe cannot drift from the mode by forgetting to
  mirror a branch. It differs only in what dying means.

## Rejected

**A hook per rendered frame.** Frame-rate-dependent gameplay desyncs and the failure is invisible on one
machine.

**`Track` as an `onFixedUpdate`.** Would have made motion uniform with everything else, at the cost of the
property that makes it free.

**A rule calling `die()` directly** instead of `effects.kill()` setting a flag. Death is gated on not already
being dead and on the fall plane in the same breath; one place deciding that is one place to read.

**Runtime-compiled component scripts.** Rejected in ADR 0035 and still rejected: a compiler dependency, a
sandbox question and a source-map story, for an audience of one author with the repo open.

**Encoding a reference's scope into its value** (`"self:p0"` versus `"level:n3"`). Explicit, and stringly-typed
in a schema small enough to resolve structurally. The scope is derivable from where the node sits, so deriving
it is strictly better than storing it and risking the two disagreeing.
