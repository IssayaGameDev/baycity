# Parkour

`modes/parkour`. The first game, and the reference for the shipped third-person stack: run, jump, checkpoints,
goal, hazards, bumpers, moving platforms. Run: `pnpm dev:parkour` (port 5174) with `pnpm dev:server`.

## Rules — `modes/parkour/src/rules.ts`

- Registry: engine + player components + `Locomotion` + the shared set in `content/parkour/game.json`
  (`Bumper`, `Checkpoint`, `Goal`, `Hazard`, `Track`).
- `parkourSession(loaded, opts)`: progress is a **checkpoint index** in tree order (`checkpointsOf`), only ever
  advancing; `respawnAt()` is the last checkpoint reached (standing height `STAND_OFFSET`) or the spawn;
  `from`/`onProgress` resume and persist it through the platform's `localProgress` (`PlayerProgress.checkpoint`).
  Death is any `Hazard` contact, kill plane included (ADR 0053). `Goal` has no rule yet.
- `spawnOf = spawnFrom(STAND_OFFSET)`.

## Descriptor — `editorMode.ts`

`PARKOUR_MODE`: `tuning: DEFAULT_TUNING`; `gizmos` for Checkpoint/Goal/Hazard/Bumper; `player`:
`Locomotion` + `Death`; `playerDefs: [createLocomotion(host)]`; no actions, no own components.

## Client — `main.ts`

`startTpsClient(PARKOUR_MODE)` and nothing else. Levels: `content/<game>/levels/*.level.json` naming `parkour`, picked with
`?level=<name>`, default `default.json`.

## Tests

`rules.test.ts` (spawning, death, checkpoint progression), `levels.test.ts`, `references.test.ts`.

Decisions: ADR 0010, 0012, 0014, 0052, 0053.
