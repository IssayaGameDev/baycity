# ADR 0064 — A game's own states travel, in bits already being sent

Status: accepted. Five game-defined flag bits, declared by `ModeDescriptor.states`, packed by `@mp/net` and
read by the game's own animator.

## Context

ADR 0063 let a game replace its animator, and the animator reads the game's own state by **closure** — the
dash component's flag is right there in the game's module. That works for the local player and cannot work for
anybody else: a peer's components do not exist on this machine, and component state is never serialized
(ADR 0059).

So a peer mid-dash was drawn running. The animation seam was real and half of it was unreachable.

## Decision

**The spare bits of the state byte are the game's, and they cost nothing.**

The flags field is a full `u8` on both hops — client→server (`state.ts`) and server→peers (`snapshot.ts`) —
and three bits were in use: `GROUNDED`, `RISING`, `DEAD`. Bits 3..7 were being transmitted and thrown away.
That is the whole budget conversation: five states are free, and a sixth needs a wider field and real bytes.

- `STATE_GAME_SHIFT` / `STATE_GAME_BITS` / `STATE_GAME_MASK` in `@mp/net`, exposed as a shift and a count
  rather than named constants, because **the netcode never learns what bit 3 means.**
- `ModeDescriptor.states?: readonly string[]` — the game's names, in bit order. `playerStates?: () => Set`
  says which are true for the local player right now, closing over whatever the game likes, the same way
  `playerDefs` does.
- `packStates` / `unpackStates` in `@mp/net`, because "given these names in this order, which bits" is the wire
  format's own business and nothing in it knows a name might mean a dash. Shared rather than per-host, since
  the sender and every viewer have to agree — a second copy of a mapping is how the editor and the game came
  to disagree about post-FX (ADR 0057).

### `AnimatorFactory` gained a states reader

`(gait, seed, states: () => ReadonlySet<string>)`. The host hands each character's animator a live reader:
for the local player it reports the same set the outgoing message was packed from, and for a peer the set
unpacked from their flags.

**One animator body covers both**, and does not have to know which it is animating. That is the property worth
having — a game writes its dash pose once, not once for itself and once for everybody else.

Read through a **box** stored per character, because the animator is constructed before the record that holds
its state exists. One store, so the reader cannot go stale.

The local player's set is read **once per frame** and used for both the send and its own rig, so what peers are
told and what we draw cannot disagree.

### Order is bit order

Appending a state is safe. Reordering silently reinterprets every peer's bits, which is why `packStates` is
the only thing that assigns them and why the ordering rule is on the field's own doc.

Declaring a sixth state throws (`TooManyStatesError`) rather than truncating: a state that works locally and
never for a peer is the worst possible failure, and it would be invisible.

A bit this build has no name for is dropped rather than guessed at, so a peer on a newer build does not animate
as something arbitrary.

## Consequences

- A peer's dash looks like a dash. The animation seam is now usable for the case it was built for.
- **Zero bytes.** The byte was already being sent.
- 13 tests: the pack/unpack round trip, the two halves of the byte never bleeding into each other, an
  undeclared name being ignored, a sixth state throwing, and the reader being live, per-character and cleared
  rather than sticky.
- `modes/_template` documents the whole shape — `states`, `playerStates`, `animator` — beside `playerDefs`.
- No behaviour changed for the shipped games; all three declare no states, so every game packs 0.

## Rejected

**Widening `AnimationInput` with a state bag.** Rejected in ADR 0063 for the local player and still wrong: the
platform would carry a value it cannot reason about, and the reader covers the peer case without it.

**Putting `packStates` in `@mp/mode`.** Tried, and it made the game-contract package depend on the netcode for
three bit constants — the same smell ADR 0061 fixed by moving `InputCommand` out of `@mp/net`. The mapping is a
wire concern; the *names* are the game's, and those are a `string[]` needing no import.

**Named constants per game state in `@mp/net`.** Would mean the netcode enumerating games' vocabularies.

**Arbitrary per-game bytes.** The honest general answer, and a real budget decision: it needs a length field, a
size cap, and a view of what the snapshot rate costs. Not needed for the stated problem, which is booleans.

## Known open

- **Valued state does not travel.** A rope's anchor point, a charge level, a target id: all need real bytes
  and a budget conversation. Booleans are what is free.
- **Five is the ceiling** until the field widens.
- **The editor's play-test still does not animate at all** (ADR 0063), so none of this is visible there.
