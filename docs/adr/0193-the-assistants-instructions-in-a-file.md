# ADR 0193 — The assistant's instructions in a file

Status: accepted. Amends ADR 0192 (the assistant). Kodjo's call: a short Markdown file tells the assistant how to
behave and where to look, as `CLAUDE.md` does for a development session.

## Context

Asked how to change a keyboard's keycap colours, the assistant read the style's data file and answered that Kodjo
had to change it in code. A Keyboard Style is a data asset, edited in the Inspector. Its prompt, written into
`agent.ts`, sent "how do I" questions to `CONTRIBUTING.md` (which says nothing of data assets), not to the docs that
say how the editor works.

## Decision

- **`ASSISTANT.md` at the repository's root is the whole system prompt**: its rules (read and report, never guess,
  `content/` is the person's to change in the editor, code is Kodjo's), the order to read the docs in
  (`docs/INDEX.md` first), and how to answer.
- **Read for every turn** from the checkout, so a deploy that changes it needs nothing more. Missing, the assistant
  is not ready and says which file.

## Rejected

- **More in `CONTRIBUTING.md`.** It is the people's guide, and would still not be the docs.
- **A stronger model.** Three times the price for an assistant that still is not told where to look.
