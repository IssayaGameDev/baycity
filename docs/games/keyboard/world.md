# The World component

`modes/keyboard/src/components/world.ts`, the pad table in `padTable.ts` (ADR 0222, Kodjo's design). A world is a
level; its `World` component is the one place for what the world pays and asks.

## `World`

Singleton; one per level — the first in Hierarchy order is the one read (`worldOf`).

| Param | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `baseXp` | number ≥ 0 | 1 | base XP per step: a step pays its pad's value times this (World 1 = 1) |
| `speedMultiplier` | number ≥ 0 | 1 | Max Speed (the global curve) times this — World 2's ×⅓ |
| `levelToEnter` | number ≥ 0 | 0 | the Level the world opens at. Nothing travels between worlds yet |
| `stages` | list | World 1's design table | a row a stage, below |
| `pads` | list of `pad: componentRef StepPad` | none | the spawn's step pads in order: a pad's place is its tier |

A stage row (`STAGE_ROW`):

| Column | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `obstacle` | componentRef Obstacle | none | the stage's Obstacle — drag one from the Hierarchy, inside a placement too (ADR 0219) |
| `level` | number | 0 | the Level it requires: the Obstacle's `requiredLevel`, its sign's "Requires Level X" |
| `wins` | number | 1 | what it pays: the Obstacle's `wins`, and so its Wins pad's |
| `gateSeconds` | number (s) | 45 | how long a run takes at its gate speed — the simulator's |
| `floorSeconds` | number (s) | 5 | the part no speed shortens (a timer, a door) — the simulator's |
| `fail` | number 0–95 | 0 | fail %: the chance a run fails (Kodjo's call) — the simulator's |

A row's place is its stage number and its Checkpoint number; dragging a row moves all of it. The defaults are the 14
stages of [world-1.md](world-1.md), each its gate speed's Level on the default speed curve, rounded up, with no
Obstacle yet.

## What it sets (`drives`)

As the level loads, through the chain the loader settles (`settleDrives`, `platform/components/api.md`):

- a stage row → its Obstacle's `wins` and `requiredLevel`, which the Obstacle sets on its Wins pad and its sign
  ([obstacles.md](obstacles.md));
- pad row `n` → that StepPad's `perStep` and `requiresWins`: the pad table's row `n` (`GAME_PADS[n]`), none past its
  end ([pads.md](pads.md)).

Those fields are `hidden` where they are set, so they are edited only here. An Obstacle or pad it does not list keeps
its own. The editor reads them through the same chain (the signs it draws).

```ts
worldOf(loaded): { node; values: WorldValues; stages: ComponentRef[] } | null   // WorldValues { baseXp; speedMultiplier; levelToEnter }
stageOrderOf(loaded): WorldNode[] | null   // its rows' Obstacles, resolved from its node, each once; null with none
NO_WORLD = { baseXp: 1, speedMultiplier: 1, levelToEnter: 0 }
```

`main.ts`: `world = worldOf(loaded)?.values ?? NO_WORLD` as each level loads; every step pays
`perStep × world.baseXp × rebirth`; `moveSpeed` is `maxSpeedAt(level) × world.speedMultiplier`. Checkpoints:
`checkpointsOf(loaded, STAND_OFFSET, stageOrderOf(loaded))`.

## In the editor

The Inspector draws `stages` and `pads` as list fields with a component column (`platform/editor.md`): a Hierarchy row
or an Inspector card dropped on a row's cell takes it, dropped on **Add** is a new row holding it; a row holding what an
earlier one does reads `· also row N`. Rows reorder by their grip.

## The pad table

`PAD_SETTINGS.pads` — a game setting (a table, games window › Settings): every tier in order, `perStep` (XP per step)
and `requiresWins` (Wins needed). Default: the shipped eight, 1/0 to 500/50K. One list for the game; each world's spawn
holds the start of it (World 1 the first 8, World 2 the first 16). `GAME_PADS` is read when the game loads, as the curves
are: an edit reaches the game at its next load.
