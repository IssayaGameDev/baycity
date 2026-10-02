# ADR 0195 — The assistant edits, in Confirm and Auto

Status: accepted. Amends ADR 0192 (read and report only). Its mode switch moved beside Send by ADR 0197; Haiku no
longer the only model, by ADR 0199. Kodjo's calls: three modes in the chat — Assistant, Confirm,
Auto; in Confirm every change is asked about, one by one; a no ends the prompt; only Kodjo has the editing modes for
now; Haiku still.

## Context

The editor's actions exist as data with the rules an agent needs (ADR 0194): one batch an action, one undo a prompt,
an undo that leaves what others changed since, and holds as the agent's fence. Nothing ran them. Kodjo wants the
assistant to change the scene — sometimes asking first, sometimes not — without losing the mode where it only teaches.

## Decision

- **A mode per chat**, chosen in its header: Assistant (as before), Confirm, Auto. The server opens the editing modes to
  the emails in a state file, `assistant-editors`, and refuses them to anyone else.
- **The model's tools in an editing mode** are the editor's reads and edits, sent by the tab with each message; never
  the view actions, so the person's selection and camera stay theirs.
- **The tab runs them**: the server streams a `call`, waits for the tab's `result`, and goes on. The tab is where the
  document, the history and the room are; a chat moved to a tab of its own reaches the editor tab over a channel.
- **Confirm asks before each change**; reads run unasked. *Don't* answers no and the turn ends there, without asking
  the model again, so the person says what they want instead.
- **Stop** ends an editing turn at its next step. However a turn ends, what it changed is one undo entry.

## Rejected

- **Confirming a batch at once** (a model response's changes together): Kodjo's call, every change.
- **Carrying on after a no**: the assistant pressing on with the rest of its plan would mostly guess wrong.
- **The server holding the editor's tool list**: it would be a second copy of the actions, out of step with the
  editor the box serves; the tab sends the list the editor it runs actually has.
- **A stronger model for editing**: Kodjo's call, Haiku; a prompt is one undo, and the model is one line to change.
