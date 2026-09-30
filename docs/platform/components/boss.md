# `Boss` — a chaser with a zone

`packages/components/src/shared/boss.ts`, tests in `shared/boss.test.ts`. ADR 0095. Shared, so a game gets it by naming
it in `content/<game>/game.json`.

Wakes when a player enters its zone, runs at the one furthest through it, parks itself back home when the zone
empties. Its own page because assembling one has rules that a table row cannot carry, and each of them was
found by getting it wrong.

Authored values live in the Inspector. None are repeated here.

## Parameters

| param | kind | is |
|---|---|---|
| `zone` | `nodeRef` | the node whose box collider is the area it patrols |
| `speed` | `number` (m/s) | how fast it drives, chasing and returning alike |
| `turn` | `number` (°/s) | how fast its heading may swing — the whole dodge window |

Declares `moves`, so the node gets a kinematic body and a live `self.offset`. No `onContact`: it does not
react to being touched, it only drives.

## The three nodes

```
<root>            empty, no components — the thing you place
├── Zone          Collider: box, trigger on
└── Boss          Boss (zone → Zone), Hazard, Collider (trigger on), Renderer (Mesh Renderer)
```

Siblings under an empty root, **not** parent and child. A component moves the node it sits on and everything
under it, so a zone parented beneath the boss would be dragged along and the area would follow its own
occupant around.

## Four rules

**The boss's collider must be a `trigger`.** A solid one is resolved by the character controller, so it shoves
players instead of killing them; and it reaches the `Hazard` only through `CharacterBody.collisions()`, which
holds what the **character's own movement** ran into — a boss driving into somebody standing still reports
nothing at all. A trigger is found by `overlaps()`, an explicit shape query run every tick wherever the capsule
is, and does not care which of the two moved (ADR 0054, `physics.md`).

**It does not kill; the `Hazard` does.** Dying is already a component. A boss with no `Hazard` is a harmless
prop that follows you around, which is a legitimate thing to build.

**The zone's forward is its own `+Z`**, after rotation — the direction the transform gizmo's blue axis draws.
That is "through" the zone, and the player furthest along it is the target: the one about to escape. Aim a
boss by rotating the **Zone**, never the placement.

**Do not rotate or scale the placement.** `self.offset` is in the node's parent space (ADR 0058), so a rotated
root makes the boss chase along skewed axes. Nothing enforces it.

## What it does

| Situation | Behaviour |
|---|---|
| zone empty | drives home at `speed`, then sits still |
| someone inside | steers at the **living** player furthest along the zone's forward, turning no faster than `turn` |
| target dies | skipped from the next tick — `PlayerView.alive`. It takes the next player in the zone, or goes home |
| target above or below | irrelevant: it drives in the horizontal plane and keeps its authored height |
| arrived | settles within one step rather than overshooting and swinging back, which read as circling |
| zone missing, or not a box | drives home and stays there, rather than hunting the whole level |

Membership is **geometric** — oriented-box containment against `ctx.players()` — and not the trigger firing.
It has to be: a sensor only ever reports the local player, because peers are relayed positions that were never
in this client's physics world. The trigger flag on the zone is about not standing on it; the box test is what
sees everybody.

## Two clients can disagree, and that is fine

Peers arrive interpolated, so two clients can pick different targets for a moment and draw the boss
centimetres apart (`ctx.players()` in [api.md](api.md)). Under client authority each client decides its own
death, so the boss still kills exactly the player whose own client says it touched them. Divergence costs
appearance, never outcome — the same bargain every `Hazard` makes.
