# ADR 0192 — An assistant in the editor

Status: accepted; its instructions moved to `ASSISTANT.md` by ADR 0193; read and report only in Assistant mode, with
editing modes beside it, by ADR 0195. Kodjo's calls: inside the editor; Claude on Kodjo's API key, the cheaper model; read and report
only — it teaches and helps, and never touches the scene, the levels or the code; it drafts issues and the person
files them; $1 a person a day; a round button at the viewport's bottom right, with the chat movable to a tab of its
own; a chat lasting as long as its tab; Anthropic's library on the server, marked and DOMPurify in the editor.

## Context

Collaborators building levels need help with the editor and run into bugs, and Kodjo wants their questions answered
and their bugs written down where the code is.

## Decision

- **The editor's server runs it**: Claude Haiku 4.5 through Anthropic's library, a turn streamed to the chat as it
  goes. Its keys live in the state directory beside the admin token and never reach the model or a browser.
- **Its tools read and report**: search, read and list the repository's tracked files, search and read issues, and
  draft an issue or a comment. A draft is filed only by the person's click, signed by the server with their name.
  There is no tool that writes, so nothing it is told can make it.
- **What it reads is refused by the server, not the model**: tracked files only, inside the checkout, never a file
  that looks secret.
- **Each person has $1 a UTC day**, priced from the usage every call reports, kept across restarts.
- **The chat is the editor's own**, a small window in the editor's look, Markdown through marked and DOMPurify. It
  lives behind a round button at the viewport's bottom right and moves, conversation and all, to a tab of its own,
  which asks the editor tab what is selected before each message.

## Rejected

- **On GitHub instead** (mention a bot in an issue). Everyone would need an account and would leave the editor.
- **GitHub's MCP server, or MCP for our own tools.** Kodjo's call: plain calls do the job; MCP can come with tools
  that act on the scene.
- **The Claude Agent SDK.** A process a conversation on the box, and its file tools need our checks all the same.
- **A ready-made chat window** (Deep Chat, NLUX). The parts that make this one — drafts to file, activity, the day's
  spend, moving tabs — would be bolted onto it, and Deep Chat is five times the size of marked and DOMPurify.
- **Filing straight from the model.** Kodjo's call: the person confirms.
