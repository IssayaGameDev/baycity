# ADR 0214 — A teleport travels as a count, and a viewer does not blend across it

Status: accepted. Kodjo's call (ADR 0202's open point, option A): others see a teleport as a vanish and an
appearance, not a streak across the map.

## Context

A viewer draws a peer between two relayed samples (`interpolateAt`). A cash-out, a teleport window pick or a respawn
moves the sender in one tick, and the blend between the sample before and the one after drew them streaking through
the level for a snapshot interval. Their collision mirror swept the same line, and their animator read the jump as a
sprint.

## Decision

- **`PlayerState.teleports` / `SnapshotEntity.teleports`**: a `u8` count of the sender's teleports, wrapping (v13,
  +1 B upstream and per relayed entity). The sender counts `respawn()` and a taken `takeTeleport`.
- **The relay forwards a change** like any other (`relayDiffers`), even to the same quantized spot.
- **A viewer seeing it change**: holds the older sample until the newer is due (the hold a base change already gets),
  places the collision mirror (`setPosition`) instead of sweeping it, and resets the rig's motion (`resetMotion`).

## Rejected

- **A one-tick flag**: the relay samples states at 20 Hz from 30 Hz upstream, so a flag set for one tick can fall
  between two samples. A count that changed between them cannot be missed — only 256 teleports between two samples
  could alias.
- **A distance threshold** ("an implausible jump is a teleport"): the character reaches about 280 m/s, 14 m between
  two samples, and a teleport can be shorter than that.
- **A bit of the flags byte**: its five spare bits are the games' (ADR 0064).
