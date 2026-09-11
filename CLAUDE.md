# CLAUDE.md — Entry Point

Always in memory. Bootstraps every session.

## Orient first, before any work

1. `SEED.md` (if present) — Kodjo's initial requirements: locked decisions, budgets, invariants, build order. Not yours to change; it has a lifecycle note and is deleted (with Kodjo's approval) once fully consumed into docs and ADRs.
2. `docs/INDEX.md` — index of system docs. Read it, then load only what the current task needs. If it doesn't exist, nothing is built yet — you create it with the first code.

## Prime directive: you never make design decisions

**Technical** = how to build what was decided → yours. **Design** = anything the player experiences, or any trade-off between budgets → never yours. No guessing, no "sensible defaults."

Blocked on design → ask Kodjo directly in conversation. Batch multiple questions into one ask; state each as context → options → trade-offs. Build nothing that depends on the answer; continue on unblocked work.

Boundary examples: snapshot header layout — technical. Interpolation buffer duration — design (game feel). Rewind buffer structure — technical. Whether a prop enters the prediction loop — design. Which mitigation when a budget is exceeded — design.

## Content files are Kodjo's work

- **Never rebuild a level file from git.** What is on disk is his work, committed or not. Edit the working copy in place; if a scripted edit breaks it, restore from a backup taken before the edit, never from a commit.

## Scope discipline

- Build only what was asked — never invent features, however obvious the addition seems
- If fulfilling a task requires a medium-or-large addition to the feature set, warn Kodjo — what and why — and wait for his go-ahead before implementing

## Code standards

- TypeScript strict; `any` is forbidden (justify rare exceptions in-line)
- Netcode logic gets unit tests: serialization round-trips, reconciliation replay, rewind correctness, clock-sync math — not optional
- No new runtime dependency without asking
- Prefer plain functions and data over classes
- Every milestone ends runnable: tests green, demo works

## Git

- One commit per completed feature request or milestone — no work-in-progress commits; a commit and its docs travel together (see documentation policy)
- Commit only after Kodjo has validated the work — never before
- Messages: imperative subject line; body only when the *why* isn't obvious from the diff. No "Co-Authored-By" or agent attribution lines
- Main stays green — never commit failing tests or a broken build to main
- Branches are for experiments and risky refactors; short-lived, merged or deleted — no long-running divergence
- Never rewrite pushed history; never force-push
- Never commit secrets or generated output (`node_modules`, `dist`, builds) — maintain `.gitignore` from the first commit
- Tag milestone completions (`m1`, `m2`, …) so any milestone state is recoverable

## Documentation policy

1. Docs are for the next agent session, not humans — dense, factual, no narrative
2. Document what exists, when it exists — never speculatively; no placeholders
3. Docs change in the same commit as the code they describe
4. Current state only — history lives in git and ADRs
5. Decisions get ADRs (short, append-only: context, choice, rejected alternatives); all other docs are rewritten or deleted when stale
6. Maintain `docs/INDEX.md`; any doc findable in one hop — structure beyond that is yours
7. Prefer code over prose; if type signatures already say it, delete the doc

Exception: one human-facing `README.md` at the root — what this is, run locally, deploy, where the index lives. Short.

## Communication with Kodjo

- Technical peer: precise terminology, no simplification, no unrequested explanations
- Short, scannable messages — bullets, headers, tables. Never walls of prose
- Almost caveman language DO NOT use inneficient or useless language