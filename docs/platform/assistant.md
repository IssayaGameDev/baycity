# Assistant (ADR 0192, ADR 0195)

An AI helper in the hosted editor: it answers "how do I…", investigates what looks broken by reading the repository,
and drafts GitHub issues and comments that the person files with a click. **Assistant mode reads and reports only**
(Kodjo's call). For the people `assistant-editors` names, **Confirm** and **Auto** change the open level or prefab
through the editor's actions (ADR 0195, *Modes* below). No mode writes a file, code or a game setting.

## Server — `tools/editor-server/src/assistant/`

| File | |
| --- | --- |
| `routes.ts` | `createAssistant({ repoRoot, stateDir, limitUsd?, talk?, github?, now? }): { handle, sweep }` — the routes below; `claudeTalk(apiKey)` the real model call; `contextOf`; `editorToolsOf`, `runOfAnswer`, `DECLINED` |
| `agent.ts` | `runTurn(conv, text, context, { instructions, tools, mode, maxRounds?, silent?, talk, run, budget }, emit)`: the loop; `MODEL`, `AssistantMode`, `EDIT_ROUNDS`, `Conversation`, `AssistantEvent`, `Shown` |
| `tools.ts` | `TOOLS` (the model's tool list), `createToolRunner({ files, github, nextDraftId })`, `activityOf`, `Draft` |
| `repoFiles.ts` | `createRepoFiles(root)`: `list`, `read`, `search`; `cleanPath`, `looksSecret`, `Refused` |
| `github.ts` | `createGitHub({ token, repo, fetch? })`: `searchIssues`, `issue`, `createIssue`, `comment`; `repoOfRemote` |
| `budget.ts` | `createBudget({ file, limit, now? })`: `spent`, `add`; `costOf(usage)`, `HAIKU_4_5_PRICES` |

Wired in `server.ts`: `createAssistant({ repoRoot, stateDir })` → `ApiOptions.assistant`, asked after the login
(`identify`) and before every other route; `sweep()` in the minute timer.

| Route (signed-in user) | |
| --- | --- |
| `GET /api/assistant` | `{ ready, why?, github, spent, limit, modes }` — `modes` all three for an email in `assistant-editors`, else `['assistant']` |
| `POST /api/assistant/chats` | `{ id }` (32 hex); 503 without a key. At most 6 open a person, the oldest dropped |
| `GET /api/assistant/chats/:id` | `{ shown, filed, busy }` — for a tab the chat moved to |
| `POST /api/assistant/chats/:id/say` | `{ text ≤ 8000, context, mode?, tools? }` → server-sent events `text` / `activity` / `draft` / `spent` / `call` / `error` / `done`, each `{ kind, … }`; keepalive 15 s. A turn runs to its end whether or not the tab stays. An editing mode not open to the person: 403 |
| `POST /api/assistant/chats/:id/result/:call` | the tab's answer to a `call`: `{ outcome: ActionOutcome }` or `{ declined: true }`, ≤ 2 MB (a picture) → 204; 404 for no such call waiting |
| `POST /api/assistant/chats/:id/stop` | 204: `stopping`, every waiting call answered — the turn ends at its next step |
| `POST /api/assistant/chats/:id/file/:draft` | files an issue or posts a comment → `{ url }`; once per draft; body + `\n\n---\nRaised by <name> in the editor.` (the server's line, not the model's) |
| `POST /api/assistant/chats/:id/close` | 204 — the tab's beacon |

A conversation is its owner's (verified email); anyone else gets 404. Kept in memory: closed by its tab, dropped after
`IDLE_MS` 6 h silent. A failed turn is rolled back out of the conversation.

**Instructions**, at the repository's root, each mode's whole system prompt: `ASSISTANT.md` for Assistant mode (ADR
0193) — its rules, where it looks (`docs/INDEX.md` first), how it answers — and `ASSISTANT-EDIT.md` for Confirm and Auto
(ADR 0196, Kodjo's call) — how the editor's things are built, the three kinds of ids, how to work. Change one to change
how that mode behaves. Read from the checkout for every turn (`INSTRUCTIONS_FILE`, `EDIT_INSTRUCTIONS_FILE`); missing:
the turn refused naming it, and Assistant mode's missing is `ready: false`.

**Model** `claude-haiku-4-5-20251001` (Kodjo's call: the cheaper, in every mode), `MAX_TOKENS` 2048, `MAX_ROUNDS` 12
calls a turn, `EDIT_ROUNDS` 30 in an editing mode.
System prompt and tools carry cache points, and so does the newest message (3 of 4). An earlier turn's tool results
older than 8 messages go back trimmed (`forModel`); this turn's never — a model that loses an id it read makes one up.

**Eval** (`tools/editor/src/assistant/assistant.eval.test.ts`, ADR 0196): six fixed prompts, each on a fresh small
level, through `runTurn`, the real model and the editor's actions in Auto: model calls, tool calls, refusals, cost, and
whether the level ended as asked. Skipped unless `ASSISTANT_EVAL=1` and `ANTHROPIC_API_KEY` are set.

**Budget** $1 a person a UTC day (Kodjo's call): `costOf` at Haiku 4.5's rates (input 1, output 5, cache write 1.25,
cache read 0.1 USD a million tokens), counted after every model call, kept in `stateDir/assistant-spend.json`. Spent:
no new turn; ran out mid-turn: the turn ends with its tool calls answered.

**Tools** — read and report:

| Tool | Does |
| --- | --- |
| `search_repo { query, path?, regex? }` | `git grep -n -I` over tracked files, ≤ 80 hits |
| `read_file { path, from_line?, to_line? }` | numbered lines, ≤ 400 a call, ≤ 400 KB file |
| `list_files { dir }` | tracked files under it, ≤ 300 |
| `search_issues { query }` / `read_issue { number }` | GitHub, this repository |
| `draft_issue { title, body, labels? }` / `draft_comment { number, body }` | a `Draft` for the person — nothing filed |

**What it can read** (`repoFiles.ts`), refused by the server whatever the model asks: only files `git ls-files` lists
(so `.env`, builds and anything ignored do not exist); only inside the checkout, the path cleaned (`..`, absolute,
`C:`) and resolved (`realpath`) first; never a name `looksSecret` (`.env*`, `*.key`, `*.pem`, `*.token`, `id_rsa…`,
`.npmrc`), tracked or not. The checkout is the box's (`/srv/editor/repo`): the deployed code and the live content.

**Keys**, in the state directory beside `admin.token`, never in the checkout, never sent to the model or a browser:
`anthropic.key` (an Anthropic API key) and `github.token` (a fine-grained token, Issues read/write, this repository
only). Looked for again while missing — no restart needed. The repository is `origin`'s (`repoOfRemote`). Readable by
the service user:

```sh
ssh root@2.28.227.20 'umask 077; cat > /var/lib/editor-server/anthropic.key && chown editor:editor /var/lib/editor-server/anthropic.key'
ssh root@2.28.227.20 'umask 077; cat > /var/lib/editor-server/github.token && chown editor:editor /var/lib/editor-server/github.token'
```

(Paste the key, Enter, Ctrl+D.) No key: `ready: false`, and the chat says it is not set up.

**Who may edit**: `assistant-editors` in the same directory, one email a line, `#` comments; read whenever asked, so
an edit to it needs no restart. Missing or empty: nobody (Kodjo's call: only him, for now).

```sh
ssh root@2.28.227.20 'echo you@example.com > /var/lib/editor-server/assistant-editors && chown editor:editor /var/lib/editor-server/assistant-editors'
```

## Editor — `tools/editor/src/assistant/`

| File | |
| --- | --- |
| `assistantDock.ts` | `createAssistantDock(stage, { context, playing })`: the round button (`.asst-fab`) at `#stage`'s bottom right and the panel (`.asst-panel`) it opens above; hidden while playing; the pop-out; the context channel; `answerLinks` for the chat tabs it opened; the close beacon on `pagehide` |
| `chatWindow.ts` | `createChatWindow({ root, chatId?, context, onPopOut?, onClose?, link? })`: the chat — one for the panel and the tab; the modes, the change card, Stop |
| `editorLink.ts` | `EditorLink { tools, begin, run, describe, end }`, `EditorTool`; `remoteLink(editorTab)` over `BroadcastChannel('mp-assistant-link')` — all a chat tab of its own loads |
| `editorLinkLocal.ts` | `localLink(editorActions)`, `toolsOf` (reads and edits, never `view`), `describeCall`, `answerLinks(tab, editorActions)` |
| `page.ts` + `assistant.html` | the chat in a tab of its own: `/assistant.html#chat=<id>&from=<tab>` |
| `assistantApi.ts` | the routes' client; `say` reads the POST's own event stream (`sseParser`); `CONTEXT_CHANNEL` |
| `markdown.ts` | `renderMarkdown`: `marked` (GFM, breaks) then DOMPurify (no `style`, `form`, `input`, `img`; links `_blank`, `noopener`); where DOMPurify cannot run, `escapeHtml` — text, never HTML |
| `assistant.css` | the chat's look, the editor's colour variables |

| | |
| --- | --- |
| a conversation | made on the first message (or on pop-out), by id; the server's. Lasts as long as its tab (Kodjo's call) |
| a message | `context()` first: `game`, `level` (qualified), `prefab`, `selection` (≤ 12, `name (Component, …)`), `problems` (the notices' last 8 warnings and errors) — sent beside the text, which the model sees in `<editor>` tags |
| the window | the intro; you / answer (Markdown, redrawn at most once a frame as it streams) / activity (`› Reading …`) / draft card (*File it* / *Post it* → `Filed ↗`, refused without GitHub); `$x of $1.00 today`; Enter sends, Shift+Enter a line |
| pop-out | ↗: `window.open` the tab with the id and this tab's token, the panel emptied — the conversation is the tab's now. The tab asks for the editor's context over `BroadcastChannel('mp-assistant-context')` before each message, addressed to that token, waiting 250 ms, else the last it heard. A conversation still answering when it moves is waited for (`busy`), then drawn |

Built as a second page: `vite.config.ts` `rollupOptions.input` `{ main, assistant }`.

## Modes (ADR 0195)

| | |
| --- | --- |
| the switch | **Assistant · Confirm · Auto** in the header (`.asst-modes`), shown when `status.modes` has more than Assistant and the chat has a `link`; a new chat is in Assistant; locked while busy; each choice says what it does (`MODE_NOTES`) |
| a message in an editing mode | `link.tools()` (`toolsOf`: the editor's reads and edits — never `select_objects` or `focus_objects`: the selection and the camera stay the person's, Kodjo's call) sent with it; `link.begin('assistant: <text>')` starts a turn, `link.end()` ends it however the turn ends — **one Ctrl+Z for the prompt** (ADR 0194) |
| a `call` | the server hands the tab an editor action and waits ≤ 15 min for `result`. The tab says it in words (`describeCall`, objects by name), then **Confirm**: an edit waits on a card (`.asst-change`) — *Apply* runs it and the card says *Applied*, or *Not applied — why*, once it has; *Don't* answers `{ declined: true }` (Kodjo's calls: every change asked; a no ends the prompt). **Auto**, or a read: run at once, the words as activity. A refusal (someone has it selected…) is shown too |
| a no | the model's tool result is `DECLINED`, the rest of the round `Not run`, and the turn ends with no further model call; the next message joins those results in one user turn |
| Stop | `.asst-stop`, while an editing turn runs: a card waiting is settled *Stopped*; `POST …/stop` |
| a picture | `screenshot_view`'s result goes to the model as an image block (`runOfAnswer`) |
| a chat tab of its own | `remoteLink(from)`: every link request to the editor tab that opened it, which runs it (`answerLinks`) with a link — and a turn — per chat tab; no answer in 3 s (60 s for an action): *the editor tab did not answer* |
