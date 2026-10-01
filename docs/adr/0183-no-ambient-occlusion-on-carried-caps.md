# ADR 0183 — No ambient occlusion on a carried board's caps

Status: accepted. Amends ADR 0154 (caps ride the board a sequence carries). Kodjo's call.

## Context

The GTAO pass (ADR 0082) draws the scene once more with one override material to find creases. That material
never gets the riding patch, so a carried board's caps are seen where they were built, at full strength: on a
moving board AO stays behind as a dark ghost of the keys, and on a faded or switched-off board it stays on.

## Decision

The riding meshes are kept out of the AO prepass (`client.excludeFromAO`), in `keycaps.ts` alone. A board is
carried or still from load (`VisualItem.animated`), so nothing new detects motion. Still boards keep their AO; a
carried board's keys lose the darkening between them.

## Rejected

- **Carrying the caps in the AO prepass too.** The pass draws everything with a single material; a per-mesh
  patched copy means reaching into how three's pass renders — more work, and fragile.
