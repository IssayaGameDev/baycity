# ADR 0228 — A countdown to a sequence's stages

Status: accepted. Kodjo's request: a sign telling the player exactly when a timed platform appears.

## Context

An obstacle's platform fades in and out on a `Sequence`; Kodjo writes signs with `Text` and wants one that says,
precisely, when the platform will appear — and when it will go.

## Decision

- **A `Countdown` component on the sign's node** (shared, adopted like `Sequence`): a `componentRef` to the
  `Sequence`, and **rows** (Kodjo's call, over one countdown to one stage): a stage number and words, `{t}` the
  seconds. The text says the row whose stage starts soonest, so one sign reads "Appears in 4.9" then "Gone in 2.9".
  Words without `{t}` are said as they are; nothing to count to — no sequence, no rows, past its last pass — the
  `Text`'s own.
- **One decimal, rounded up** (Kodjo's call): the last it reads before its moment is 0.1, never 0.0.
- **On the sequence's own clock**: `untilStage` (`sequence.ts`) from the same time the stage's poses are read at, so
  a shared sequence's countdown is the same on every screen, with nothing on the wire. A yo-yo counts its forward
  passes only: backward, a fade-in fades out.
- **Loader-evaluated, no hook**, as a sequence is: `update` writes `TextItem.text`, and `addTexts`' `sync` lays a
  text out again only when its words changed. The editor's Motion preview counts too (`posesAt` →
  `PreviewPose.text` → `setTextAt`), and gives the text its own words back when the clock stops.

## Rejected

- **A token in the Text itself** (`{t:stage 2}`): the reference to the sequence would live in a string, and follow no
  re-id.
- **A runtime hook**: a sign has to count in the editor's preview, where hooks do not run.
