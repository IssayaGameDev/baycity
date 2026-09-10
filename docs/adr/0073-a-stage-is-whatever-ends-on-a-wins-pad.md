# ADR 0073 — A stage is whatever ends on a Wins pad

Status: accepted. `modes/keyboard` has stages, Wins and cashing out; `ModeSession` gained `takeTeleport`.

## Context

The game being cloned is a **world** of stages laid end to end from one spawn. Each stage is a run of
obstacles ending on a yellow pad. Stepping on the pad pays that stage's **Wins** — a second currency, separate
from the step-earned one — and teleports you back to the spawn to go again. Wins buy the multipliers and pets
that make the next stage reachable.

Kodjo's design calls, which shape everything below:

- **No checkpoints.** Falling anywhere is back to the level's spawn, however deep into the world you were.
- **Nothing locks a stage.** The real game gates by Level; here every stage is open and the obstacles are the
  gate.
- **Stages are laid out in the editor**, not declared in data.

## Decision

### A stage is not a thing

There is no `Stage` component, node, group or list. A stage is **whatever platforms sit between the spawn and a
`WinsPad`**, and the pad is the whole of its identity: touch it, bank its `wins`, go back to spawn. With no
checkpoints and no locks there is nothing else a stage would need to say about itself, so declaring one would
be a second copy of what the layout already says.

An earlier draft had a `StageStart` pad as a per-stage respawn point. It was a checkpoint under another name,
and Kodjo had already said no checkpoints. Dropped.

### `WinsPad`, and it speaks through `progress`

One component, owned by the game, one parameter (`wins`, default 1). It fires the existing `effects.progress(node)`
on contact — the one effect that already carries a node — and the game's session reads `WinsPad` off that node
and reacts. The shared `Effects` did not change: a game with a rule the platform has no word for can still say
it through the node, which is the same move `Checkpoint` makes.

Standing on the pad reports a contact every tick until the teleport lands. The session pays **once**: a
cash-out already waiting to be applied swallows further contacts, and the pad pays again only after the
teleport has been consumed and the player has come back.

### `takeTeleport`: moving a player is not killing one

Until now the platform could relocate a player in exactly one way — by killing them: ragdoll, wait for a click,
reassemble. Cashing out must not look like any of that.

`ModeSession.takeTeleport?: () => Vec3 | null`, the same consume-on-read shape as `takeDeath`, so a host asking
once per tick cannot apply one teleport twice. Both hosts read it — the game client and the editor's play-test —
and both do the same thing: set the body's position, zero its velocity, drop `grounded`. The rig stays whole.

Optional, because most sessions never move anybody. `parkour`, `swing` and `_template` are untouched.

### Wins are the game's own, like Experience

Saved to the game's own `localStorage` key (ADR 0071's reasoning), on the same 3-second timer. The HUD shows
them as a plain line on the left edge, vertically centred — a placement, not yet a look. The `+N Wins` payout
pops from the pad's **top face** through the same popups as the keys (ADR 0072), on the frame after the
teleport, so the player sees what they earned from where they earned it before the spawn fills the screen.

The client hears about a payout through `KeyboardSessionOptions.onCashOut`, which the game's `main.ts` supplies
by wrapping its own `session` before handing the descriptor to `startTpsClient`. The rules stay headless: the
editor calls them with no callback and still teleports.

### The level has one stage

A yellow pad after the last board, paying 1. Enough to see the loop close; the rest is Kodjo's, in the editor.

## Consequences

- Walk five boards, stand on the pad: `+1 Wins`, back at spawn, counter up. Fall: back at spawn, counter
  unchanged.
- `WinsPad` is in the keyboard editor's Add Component menu; its gizmo uses the palette's goal colour.
- 7 tests on the session: pays once, does not double-pay while pending, ignores non-pads, defaults to 1, pad
  top, death still goes to spawn, nothing persists through the platform.
- Peers see a teleport as a position snap. Nothing on the wire changed.

## Rejected

**A `StageStart` respawn pad.** A checkpoint by another name.

**A stage as a volume or an ordered list.** Nothing would read it: no locks, no per-stage respawn, no
per-stage save.

**Cashing out as a death without a ragdoll.** Still the death path — the wait for a click, the reassembly, the
`dead` gating on contacts. Wrong shape for "you did it".

**A new `Effects` entry.** `progress(node)` already carries everything the session needs.

**Wins on `PlayerProgress`.** A game's stat in the platform's save shape (ADR 0071).

## Known open

- **Wins buy nothing yet.** No multipliers, pets or rebirth, so the counter only climbs.
- **Nothing resumes a run.** A reload is a spawn; that is the design, not a gap.
- **Boards past z = 40 exceed `QUANT_BOUND`** (ADR 0011), so a peer that far out is clamped on the wire. The
  pad is at z = 56. Was already true of the last board.
- The HUD's Wins line is placed, not designed.
