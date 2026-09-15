# ADR 0100 — Moving the character from outside the controller releases its footing

Status: accepted. A correctness rule for callers of `stepCharacter`; changes nothing about ADR 0012's carry or
ADR 0021's relative-to-base replication, both of which were working as designed.

## Context

Kodjo, mid-playtest: a player dies, clicks to respawn, arrives at the spawn point — and a moment later is
somewhere in the air. Intermittent.

`respawn()` set the body's position and zeroed velocity and footing. It did **not** clear `base`, the record of
which clock-driven piece the character was standing on, and neither did `die()`.

So the character respawned still attached to the platform it died on, and on the next tick:

1. No ground under it at the spawn, so the controller took its **second, longer look** for the surface it was
   riding — the bounce-fall guard, which exists so a fast descending deck is not lost.
2. That probe reaches down by exactly how far the stored footing has fallen away. If it hit the same collider,
   the base was re-acquired.
3. The controller then computed the displacement from where the character is to **where it was standing when it
   died**, and handed that to the move as ordinary ride movement.

The player was dragged back onto their old footing. If that platform sat above the spawn, or had moved since,
they ended up in the air. It needed the old footing to be *below* the spawn and a straight-down ray of that
length to hit that same collider, which is why it was intermittent: pure geometry.

A second symptom from the same cause, which explains reports of players floating: while `base` is set, the
position on the wire is the **local** one (ADR 0021), so everyone else drew that player at their old spot on
the platform, wherever it had since moved to.

And the same bug sat in the stage teleport (`takeTeleport`, ADR 0073), which also set the position and left
`base` behind — so cashing out while riding a platform could yank you too. Found by looking, not reported.

## Decision

**`releaseFooting(state)`** in `@mp/humanoid`, called wherever something outside the controller moves the
character. Two callers today: the respawn and the stage teleport.

It clears `base`, `carry` (last tick's platform push) and `liftVel`/`liftStore` (a departed mover's momentum
held for a late jump, which would otherwise hand a fresh spawn a free boost). Velocity and `grounded` go with
them, because both callers were already zeroing those by hand and one call is one thing to remember.

A named function rather than four more lines at each site: the rule is about a *moment* — "this character was
moved by something that is not the controller" — and a rule with a name is one a third caller will find.

## Rejected

- **Clearing `base` inside `stepCharacter` when the body has moved unexpectedly.** The controller cannot tell
  an external teleport from its own resolution; guessing from a distance threshold would break the
  bounce-fall guard, which exists precisely because a large unexplained drop is legitimate.
- **Clearing it in `die()` instead.** The capsule keeps being stepped while dead (it drives the ragdoll), so
  the drag could happen before the click. Releasing on the move is the moment that matters; doing it on death
  as well would be belt and braces with a second place to forget.
- **Also clearing `coyote` and `jumpBuffer`.** Arguable either way — a jump press buffered just before a
  teleport firing on arrival is odd but harmless — and nobody has asked. Left alone deliberately, and
  recorded here so the next person does not have to wonder whether it was missed.
- **Fixing only the respawn.** The teleport has the identical defect. One helper, both sites.

## Consequences

- `CharacterState` has a documented reset. A game that moves its own character must call it.
- The reproduction is a test: a character riding a deck, teleported 10 m up with gravity off, ends the next
  tick below 6 m without the release and at 13 m with it. It would have caught this.
