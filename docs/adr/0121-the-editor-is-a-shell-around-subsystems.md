# ADR 0121 — The editor is a shell around subsystems

Status: accepted, applied progressively. Extends the panel convention of ADR 0024.

## Context

`tools/editor/src/main.ts` reached 4361 lines. Not one tangled thing: roughly fifteen subsystems — play, live
collab, item meshes, the gizmo, picking, history, panel wiring — sharing **78 module-level mutable variables**.
That sharing was the only reason they were one file.

The cost was not aesthetic. `playing` was read from twenty places with nothing saying who could write it.
`uiChanged`, `inspectorRebuild` and `inspectorSync` were declared at line 143 and assigned at line 4216, a
forward-declaration hack to break a cycle inside a single file. And the bug behind ADR 0120 — meshes built
before their group was in the scene — was invisible because the two halves of the invariant sat 150 lines apart
among unrelated state.

## Decision

**`main.ts` is a shell: state it genuinely owns, construction, host literals, boot. Everything else is a
subsystem module that owns its own state.**

Two conventions, both already in this codebase, applied wider:

| Convention | Already in | Rule |
|---|---|---|
| pure arithmetic is its own module | `selection.ts`, `snap.ts`, `facePull.ts`, `surfaceGrid.ts` | no DOM, no three, tested |
| stateful things take a getter bag | `InspectorHost`, `ToolbarActions`, `Project` | `() =>` getters in, callbacks out; never a snapshot |

A subsystem extraction is therefore: **its own mutable state moves inside and becomes private; what it needs
from the editor arrives as a host interface.** Every extraction *reduces* the 78 rather than relocating it —
`play.ts` took nine variables private and asks for twenty-three named things, which is the dependency list that
was previously unwritten.

**Host entries are arrows, always**, even where a bare reference would compile. A subsystem is constructed at
module init and half of what it wants is declared further down the shell; `saveNow` and `setStatus` failed to
compile as bare references on the first attempt. An arrow defers the read, so a host cannot be broken by
declaration order.

**Each phase is pure code motion.** No renames, no logic changes, no opportunistic cleanups — because there is
no test on any of this wiring (it is DOM, three.js and a live server), so "behaviour-preserving" rests on
typechecking plus a person looking at the box. A fix hidden inside a 400-line move is a fix nobody can bisect;
anything found mid-move is reported and fixed separately.

**Phases, ordered by how obvious a regression is**, one commit each:

| # | Module | Breakage shows up as |
|---|---|---|
| 1 | `play.ts` | Play does nothing |
| 2 | `itemMeshes.ts` | the viewport draws wrong, instantly |
| 3 | `liveSession.ts` | needs a second editor to see |
| 4 | `historyStore.ts` | Ctrl+Z |
| 5 | `gizmoTool.ts`, `pickTool.ts` | dragging |
| 6 | `hosts/*.ts` | the panels, visibly |

Play first because its boundary is the cleanest and a failure is unmistakable. Panel wiring last because it is
the largest and the most mechanical, by which point the pattern is settled.

## Rejected

- **One shared `editorState.ts`** holding the 78 variables, imported everywhere. The quickest route and the
  wrong one: it makes the god-file a god-state, and nothing ever gets to own anything.
- **Leaf extraction only** — keep moving pure helpers out and leave the stateful core alone. Safe, and it stops
  short of the actual problem: the arithmetic was already out (four modules), and `main.ts` still grew.
- **A framework or an event bus.** No UI framework is the standing decision (ADR 0024), and an event bus trades
  an explicit dependency list for an implicit one.
- **All phases in one commit.** Cheaper to write, impossible to bisect, and unvalidatable: a code change only
  reaches Kodjo by deploy, so six moves would be tested at once.
