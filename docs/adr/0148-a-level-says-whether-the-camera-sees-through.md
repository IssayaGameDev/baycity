# ADR 0148 — A level says whether the camera sees through; by default it collides

Status: accepted. Amends [ADR 0055](0055-see-through-obstructions.md): its hole becomes a level's choice, and
the default goes back to [ADR 0020](0020-camera.md)'s camera, which the obstruction stops.

## Context

Since ADR 0055 the game camera kept its distance through anything in the way and holed it. Kodjo asked for
the opposite by default — the camera stopped by geometry — with a switch. Nothing let a level, or a surface,
say which it wanted.

ADR 0020's behaviour was never removed: the sweep along the boom, the hard clamp and the lookahead's soft
limit are what still ran inside solid and below the feet. The hole is one branch on top of them.

## Decision

| | |
| --- | --- |
| where | **per level**: `LevelConfig.cameraSeeThrough?: boolean`, absent = `false`; only `true` is written. Kodjo's choice over per game (`game.json`), because it depends on how the level is built |
| off | `occlusionFor(..., { seeThrough: false })` returns the boom's own hit as the limit after the **one** cast: no probes down the body, no overlap query, no hole. The eases and the lookahead work on it unchanged |
| on | ADR 0055, unchanged |
| editor | Inspector → the **Environment** row → a **Camera** section, `see through`. `Doc.cameraSeeThrough` / `setCameraSeeThrough` → op `setCameraSeeThrough { seeThrough }`, level-only |
| game | `createOrbitCamera(..., { params: { camSeeThrough } })` from the level; play-in-place sets it per play |
| debug | `CameraParams.camSeeThrough`, a checkbox in the Debug pane's Camera folder, to compare the two live |

An authored shot (ADR 0060) on a level that does not see through gets no hole: a wall between it and the
character stays in the shot.

## Rejected

- **Per game**, in `game.json`. One answer for every level, when the answer follows the level's architecture:
  open platforms read well seen through, rooms do not.
- **Per surface**, a flag on the `Collider`. Asked about as a later need, not now: a new parameter, a filter in
  the cast and its editor UI, where one switch per level answers today's question.
- **Deleting the hole.** It is the right answer on open platforms, and a level can still ask for it.
