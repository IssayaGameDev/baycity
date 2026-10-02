# ADR 0200 — An admin page, for the admins

Status: accepted. Amends ADR 0192 ($1 a person a day, set in the code). Kodjo's calls: a page of its own, opened
from the editor; admin a role of its own, an `admins` file on the box with his email; first in it, everyone's daily
limit, his own, each person's day so far, and a reset for each person.

## Context

Kodjo ran out of his $1 for the day while trying the stronger models (ADR 0199). The limit was a number in the code:
changing it was a commit and a deploy, and starting a day again was deleting a file on the box and a restart — which
started everyone's.

## Decision

- **An admin is an email in `stateDir/admins`**, read on every request, like `assistant-editors` but its own list.
  `/api/me` says `admin: true` to them alone; the editor's top bar shows them **Admin**.
- **`/admin.html`**, a third page of the editor's build, in a tab of its own: everyone's limit, the admin's own, and
  a table of who has spent what today, with a **Reset** per person.
- **Limits kept on the box** (`assistant-limits.json`), so a deploy or a restart keeps them; $1 for everyone until set.
- **Under `/api/assistant/admin`**: the assistant owns the budget, so its routes own its admin; each one checks
  `admins`.

## Rejected

- **A panel inside the editor**: Kodjo's call, its own tab — out of the way of the people building levels.
- **`assistant-editors` as the admin list**: someone may edit with the assistant without being an admin.
- **One reset for everyone**: Kodjo's call, per person — one person's day, not all of them.
- **A file on the box to edit for the limits**: no page, and every change an ssh.
