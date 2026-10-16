# ADR 0230 — Ice keeps a little grip

Status: accepted. Amends ADR 0229's grip.

## Context

ADR 0229 scaled the player's speeding up and braking by the floor's friction share. Kodjo tested friction 0: landing
on it, nothing he pressed changed his speed or direction — a frictionless floor gave no grip at all, an air-hockey
table rather than the ice a game means.

## Decision

- **Pushing a direction uses the player's grip, never under 10 %** (Kodjo's call, over input at full strength with
  friction only braking — Keyboard is played holding a direction, so that ice would hardly be felt):
  `grip = 0.1 + 0.9 × held`, `held` the floor's friction share (`friction ÷ 0.5`, capped at 1). On a frictionless floor
  you steer and turn round, slowly.
- **Letting go uses what the floor holds with, `held`**, and so does holding against a slope: on friction 0 you glide
  on and slide down a slope, as ADR 0229 had it. Above 0 you stop, the later the less friction.
- A floor nobody set is unchanged: `held` 1, `grip` 1.

## Rejected

- **A floor on both**: with a tenth of grip always holding, no walkable slope ever slid, which Kodjo asked for.
