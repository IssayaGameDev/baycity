# ADR 0209 — Dead, the camera follows the corpse's head

Status: accepted. Kodjo's ask: dead, the camera followed the capsule, which is invisible — "pretty much nothing".

## Context

The capsule keeps being stepped while dead (it drives the ragdoll and the platforms) and stays where it died. The
picture is the ragdoll, which falls, rolls and slides away from it, and the camera kept looking at the empty spot.

## Decision

- **While dead, the camera aims at the corpse's head** as drawn this frame (`Avatars.corpseHead`, `Ragdoll.partAt`:
  the same interpolation as the mesh). Respawn goes back to the capsule, as it already jumped to the spawn.
- **`OrbitCamera.update` takes it as `focus`**: aimed at exactly rather than a metre above, it is the only sightline
  probed, nothing below it is seen through (`feetY`), and the hole is centred on it.
- **No corpse, no focus**: a game with `ragdoll: false` keeps the capsule.

## Rejected

- **Passing the head as `body`, lowered by `AIM_RISE`**: the probes down the body and the feet height are measured
  from `body`, so with the head on the floor they sat under it and holed the ground.
