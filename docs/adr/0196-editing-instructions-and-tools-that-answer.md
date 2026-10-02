# ADR 0196 — Editing instructions of their own, and tools that answer

Status: accepted. Kodjo's calls: the editing modes get a system prompt of their own; the tools stay low-level, one
thing each, rather than shaped around a task.

## Context

The first real Confirm run ("a red sphere with the Hazard material") took about fourteen calls where three would do:
an empty object and a component named by its label, a deleted object, a made-up asset id, a card that said Applied
over a refusal. The causes were the harness's, not the model's: built-in shapes invisible to the actions and refused
by a model field; this turn's own results trimmed, so an id read early was gone; refusals that said no without saying
what would work; nothing telling the model how this editor's objects are built; a prompt written for reading.

## Decision

- **`ASSISTANT-EDIT.md`** is Confirm's and Auto's whole system prompt; `ASSISTANT.md` is Assistant mode's again.
- **Every edit answers with what it changed**, in the shape a read has, ids and all.
- **A refusal names what would have worked**: the type for a label, the nearest names, an asset's id.
- **Built-in shapes are listed and taken** where a model is.
- **This turn's tool results go back whole.** Earlier turns' are still trimmed.
- **An eval** of fixed prompts against the real model measures calls, refusals and cost.

## Rejected

- **Fine-tuning a model** on the editor: the failures were missing information and bugs, which training does not
  fix, and the editor changes weekly — a tuned model would go stale.
- **Tools shaped around tasks** (`create_object` taking a material): Kodjo's call — they would fit one conversation and
  stop the agent doing exactly what it is asked.
- **A stronger model first**: not before the harness is measured; Haiku stays (ADR 0195).
