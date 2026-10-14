# ADR 0222 — The World component: a level's balance in one place

Status: accepted. Kodjo's design, step 1 of making Keyboard's balance shapeable: one place for every number, then a
simulator that reads it (step 2), then targets to shape against (step 3).

## Context

The economy was scattered: curves in the game's settings, Wins on each InterLevel placement, step-pad values inside
the Spawn prefab, stage order the Hierarchy's. A world (a level) has its own numbers — base XP per step, a speed
multiplier, its stages — beside the game's global ones.

## Decision

- **Global, in the game's settings**: the curves, and a **pad table** — every tier in order — through a new setting
  kind, `table` (rows of numbers, drawn with the list field).
- **Per world, a `World` component on its level** (Kodjo's call, over level settings, so ADR 0053 stands): base XP per
  step, speed multiplier, Level to enter, a **stages** list — each row the Obstacle and its Level, Wins, run time,
  floor and falls — and a **pads** list, a pad's place its tier. A row's place is its stage and Checkpoint number;
  dragging a row moves all of it (Kodjo's call).
- **It sets them as the level loads** (`drives`), on the Obstacles and pads it lists; the Obstacle passes its Wins and
  Level on to its pad and sign — so drives now **settle down a chain**. The fields it sets are **hidden** where they
  live (`ParamSpec.hidden`), edited only on the World.
- **A list may hold references** — a component column, drop to fill or to add a row — and they follow every re-id as a
  plain reference does (`refPathsOf`: `key[].column`, `retargetParams`).
- **Defaults**: the stages are World 1's design table (`world-1.md`), the pad table today's eight, so no content
  changes on the box; `WinsPad.stage`, never read, is gone.

## Rejected

- **Level settings** (a `config.settings` block and a Level-row section): a component is what this system makes
  level-wide values of, and it carries references.
- **Numbering by Hierarchy order**: Kodjo wants the list, ordered by hand.
- **Values on each stage's own node**: two places to look, and nothing to see the whole world in.
