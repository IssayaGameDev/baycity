# ADR 0197 — The assistant's chats are kept, and its mode sits by Send

Status: accepted. Amends ADR 0192 (a chat lasting as long as its tab) and ADR 0195 (the mode switch in the header).
Kodjo's calls: the mode a dropdown beside Send; sessions kept on the server's disk; deleted after 30 days unused; a
dropdown to list them; a warning once they all pass a size.

## Context

A chat ended when its tab did, so a question asked yesterday, or an edit session left mid-way, was gone with a
reload — and the box is redeployed often. The three modes sat in the header as three buttons, read as three tabs of
the chat rather than one choice about the next message.

## Decision

- **A session is kept**, per person, one file each in the state directory, written after each turn; reloads, other
  browsers and deploys all find it. A tab closing no longer ends it; Delete does, asked once more.
- **Thirty days unused** and it is swept; the sweep measures what is left, and past the warning size the people who
  edit are told, and the server logs it.
- **Pictures of the viewport are not kept**: they matter to the turn that took them, and they are most of the bytes.
- **The Chats menu** is the header's title: New chat, the saved ones latest first, a delete on each.
- **The mode is a dropdown beside Send**, the mode the next message goes in; a saved chat opens in its last one.

## Rejected

- **Sessions in server memory**: every deploy would wipe them.
- **Kept until deleted, with a count to cap them**: Kodjo's call, thirty days.
- **A side list of chats**: the panel is 400 px; a list beside the chat would squeeze it.
- **A button cycling the modes**: a click would change the mode by surprise; the dropdown shows all three.
