# ADR 0199 — The assistant's model is picked per message

Status: accepted. Amends ADR 0192 and ADR 0195 (Haiku, in every mode). Kodjo's calls: a model dropdown; changeable at
any message, not only before a chat starts; only he picks — everyone else stays on Haiku.

## Context

Haiku edits well enough for most of what was asked (ADR 0196, 0198), but misreads some of it — a move's point taken
from the step before, a loop that jumps. Whether a stronger model does better is Kodjo's to judge by trying, and the
model was one constant.

## Decision

- **Four models** (`models.ts`): Haiku 4.5 (the default), Sonnet 5.5, Opus 5.5, Fable 5.1, each with Anthropic's
  prices, so `costOf` counts the day at the rates of the model that answered.
- **Picked beside the mode**, sent with each message, kept with the chat; a saved chat opens on its last.
- **Any message may change it**: the conversation is plain text and tool calls, which any of them reads; the price is
  one cache write on the new model's first call.
- **The same people as the editing modes** (`assistant-editors`): the status lists the models only to them, and the
  server refuses anyone else a model but the default.

## Rejected

- **Only before the first message**: Kodjo's call, any message — nothing technical needs the lock.
- **Everyone picks**: the bill is Kodjo's, and the $1 a day goes ten times faster on Fable.
- **A file of its own for who picks**: one list of who has the strong tools is simpler to keep; it splits when the two
  stop being the same people.
