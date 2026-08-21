# ADR 0053 — The kill plane is a hazard, not a level setting

Status: accepted. Amends ADR 0052, which moved these settings rather than questioning them.

## Context

`LevelConfig` carried `fallBehavior: 'respawn-checkpoint' | 'physical-fall'` and `fallY` from the ADR 0014 era,
before the component system existed. ADR 0052 moved them out of the engine's schema into parkour's
`mode.config`, declared like a component's parameters and drawn in a new Game section.

Kodjo: *"I don't really understand why falling and the kill plane are hierarchy in the parkour game
parameters... maybe should be remade as a component or game-specific system."*

He is right, and the move was the mistake. "Falling past this height kills you" is a **rule**. Every other rule
in this system — `Hazard`, `Checkpoint`, `Bumper` — is a component on a node, reached by real engine contact.
Relocating a rule into a settings panel preserved a shape that predated components instead of asking whether it
should still exist.

## Decision

**A kill plane is a `Hazard` on a wide flat collider under the level.** No new component, no new mechanism: the
rule already exists and already works. You touch it, `onContact` fires, `effects.kill()` runs.

So `fallBehavior`, `fallY`, and the whole level-settings apparatus are deleted:

- `ModeDescriptor.config` and `@mp/mode`'s `modeParams` — their only user was these two knobs.
- `ModeRef.params` — the schema's untyped bag for them.
- `Doc.setModeParams`, and the generated fields in the editor's Game section, which now holds one dropdown.
- `ModeSession.takeDeath(position)` → `takeDeath()`. Every death is a rule firing, so the rules no longer need
  to know where the player is.
- `addParam`'s `ParamIo` generalisation (ADR 0052), reverted: with the level-settings caller gone it had one
  caller and two dead optional branches.

**`physical-fall` did not need replacing.** A tower is a level with no plane under it. The enum described a
choice that the presence or absence of an object now makes.

### What it buys

- The plane is **visible and draggable**, where it was an invisible number in a panel.
- Its extent is authored, so it can cover part of a level rather than all of it.
- Death has **one path**. The two hand-written copies of ADR 0052's context could not have drifted, because
  there is nothing left to drift.

### Migration

Every shipped level gained a `kill plane` node at its old `fallY`: a box with `halfExtents` `{120, 3, 120}`,
positioned so its **top face** sits exactly where the old plane was. `Collider` + `Renderer` (the hazard
material) + `Hazard`.

Six metres thick is deliberate. `maxFallSpeed` is 60 m/s and the step is 1/60 s, so a falling character covers
one metre per step — six is six steps of overlap, and tunnelling is not possible.

It gets a `Renderer` because `Doc.meshSpecs` returns nothing without one, so a collider-only node is invisible
*and unclickable* in the editor. That would have defeated the point.

## Consequences

- `mode.config` is gone, so **parkour declares no level settings at all**, and the Game row is one dropdown:
  which game this level is for.
- Three new content guards in `modes/parkour/src/levels.test.ts`, because making the plane authored made one
  new mistake possible: drag it up into the level and the level is instantly lethal, or spawn inside it and die
  forever. They assert, per shipped level, that the plane's top face is below every top-level node, that every
  spawn marker is above it, and that it is thick and wide enough to catch a fall. A level with no plane is
  skipped — that is a legal tower.
- `Hazard` → `kill` was already covered in `@mp/components`, so the plane uses a tested mechanism and needed no
  test of its own.
- A red plane is now visible below each level, through gaps between platforms. That is honest: there *is* a
  deadly surface there, and it used to be invisible.
- `LevelConfig` is down to `mode: { name }` and `environment`.

## Rejected

**A `KillPlane` component.** A node whose Y position is the plane, checked per tick. It needs the character's
position, which `Ctx` does not offer — so it would mean widening the component runtime's contract to serve one
rule that contact already serves.

**Keeping `fallY` as a level setting and adding the plane as well.** Two ways to say one thing, one of them
invisible.

**Keeping `ModeDescriptor.config` for a future game's settings.** No caller, so it would be an untested seam
carried on speculation. It is a small thing to re-add the day a game has a genuine level-wide *value* — a lap
count, a time limit — rather than a rule.
