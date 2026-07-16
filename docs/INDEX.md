# Docs Index

System documentation for the multiplayer stack. Read this, then load only what
the current task needs.

Current state: **M1 — Scaffold complete.** Program and build order live in
`SEED.md` §7 (active program is M1–M8).

## Docs

- [workspace.md](workspace.md) — monorepo layout, dependency laws, conventions, scripts.
- ADRs (`adr/`, append-only decision records):
  - [0001-monorepo-tooling.md](adr/0001-monorepo-tooling.md) — pnpm workspaces, source-first TS, Vitest, per-package typecheck.

## Not built yet

Everything past scaffolding. The seven `packages/*` exist as skeletons only —
each is a version banner plus a smoke test. Real modules land per the SEED §7
build order. `games/`, `tools/`, `infra/` are empty placeholders.
