# ADR 0001 — Monorepo tooling

Status: accepted (M1)

## Context

SEED §6 mandates a monorepo (pnpm workspaces or equivalent) with a strict one-way
dependency flow and headless simulation (sim never imports rendering). M1 needs:
TypeScript strict, a test runner, and package skeletons — every milestone ends
runnable (tests green).

## Decision

- **pnpm workspaces** — the SEED default. Content-addressed store, strict
  non-flat `node_modules`, good workspace ergonomics. Pinned via `packageManager`.
- **Source-first packages** — each `package.json` `exports` points directly at
  `./src/index.ts`; no per-package build/emit. With `moduleResolution: bundler`,
  Vite (client/render), Vitest (tests), and `tsc --noEmit` (typecheck) all consume
  TypeScript sources directly. An emit step is added only when publishing or
  Node-native execution requires it.
- **Vitest** — pairs with the locked Vite client build (SEED §2); ESM- and
  TS-native, fast, minimal config.
- **Per-package `tsc --noEmit` typecheck** (driven by `pnpm --filter "./packages/*"`)
  rather than one root program or TS project references. This lets each package set
  its own `lib`: headless packages (`core`/`net`/`physics`/`server`/`client`) get
  `ES2022` only, while `render-*` add DOM. That enforces the SEED §6 sim/render
  boundary at the type level, with no `composite`/emit ceremony.
- **`@mp/*` package scope.**

## Rejected

- **npm / yarn workspaces** — SEED names pnpm; no reason to deviate.
- **TS project references (`tsc -b`)** — requires `composite` + emit + `.tsbuildinfo`;
  heavier than needed while packages are source-first and unpublished. Revisit if
  build performance or emitted artifacts become necessary.
- **Single root tsconfig program** — cannot apply per-package `lib`, so headless
  packages would see DOM globals, weakening the sim/render boundary.
- **Jest** — heavier ESM/TS setup, no synergy with the locked Vite toolchain.
