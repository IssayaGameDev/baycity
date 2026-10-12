# ADR 0208 — A touch in any slice of a tick counts

Status: accepted. Kodjo's report: with jump held, a player bounced on lava (a `Hazard`) a few times before dying.

## Context

A fast mover anywhere in the level slices every tick (ADR 0104) — Obstacle 13's keys, 7 m in 0.2 s, slice the
whole level whenever one of them drops. The rules got what the capsule touched once, at the tick's end, and
`touching()`, `collisions()` and `overlaps()` each answer for the last slice only. With jump held, the landing
was one slice and the jump the next, so at the tick's end the capsule was in the air and nothing had touched the
lava. Without jump held it was still standing on it, and died. Each landing a coin flip, hence a few bounces.

## Decision

- **Read after every slice** (`contactsNow`, `packages/tps/src/contacts.ts`), into one set per tick.
- **Hand the set to the rules once, at the tick's end**, as before: `onContact` still runs once per handle per tick,
  and death, teleport and the rest still resolve where they did.

## Rejected

- **Running `components.contact` per slice**: a rule would fire two or three times in a sliced tick and once in a
  plain one, so how often `onContact` runs would depend on what else moves in the level.
- **Only the slice that moved the capsule into something**: `touching()` also reports what moved into it, and that
  can happen in any slice.
