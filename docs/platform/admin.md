# Admin (ADR 0200)

An admin role, and a page of its own for it: `/admin.html`, opened from the editor's top bar. One section so far, the
assistant's limits and each person's day (`assistant.md`).

## Who is an admin

`stateDir/admins` on the box: one email a line, `#` comments, case ignored; read every time it is asked
(`listedIn`, `isAdmin` — `tools/editor-server/src/admins.ts`), so an edit needs no restart. Missing or empty: nobody
(Kodjo's call: only him). Not the same list as `assistant-editors`, which opens the assistant's editing modes and
models.

```sh
ssh root@2.28.227.20 'echo you@example.com > /var/lib/editor-server/admins && chown editor:editor /var/lib/editor-server/admins'
```

## Server

| | |
| --- | --- |
| `GET /api/me` | `admin: true` for an admin, nothing for anyone else (`ApiOptions.isAdmin`, wired in `server.ts`) |
| `GET /api/assistant/admin` | `{ you, everyone, own, people: { email, spent, limit }[] }` |
| `PUT /api/assistant/admin/limits` | `{ everyone?, own? }` → the same; `own: null` follows everyone's |
| `POST /api/assistant/admin/reset` | `{ email }` → the same |

Each admin route is 403 unless the email is in `admins`, checked on every request. The page's HTML is served to
anyone the login lets in; what it shows is the routes'. Kept in the state directory: `assistant-limits.json`.

## Editor — `tools/editor/admin.html`, `src/admin/`

| | |
| --- | --- |
| the button | the top bar's **Admin** (shield icon), before the bell: `ToolbarState.admin` from `me.admin`; hidden for anyone else; `window.open('/admin.html', '_blank', 'noopener')` |
| `adminPage.ts` | `createAdminPage(root)`, `AdminView`: **Everyone** and **You (email)** in dollars — empty for everyone's — and Save; then a table of each person's day: email, spent today, limit, **Reset** (off at $0). Every change redraws from the answer; a refusal is said in red |
| `page.ts` | the page's entry; `admin.css` its look, the editor's colours |

Built as the third page: `vite.config.ts` `rollupOptions.input.admin`. No admin page in the dev editor: it has no
assistant, and the page says so.
