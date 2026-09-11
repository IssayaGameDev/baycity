# ADR 0083 — Content is authored on a hosted editor

Status: accepted. The editor's file API is a package, `tools/editor-server`, that runs both inside `pnpm
dev:editor` and as a service on a VPS behind Cloudflare Access at `editor.playgorbo.com`. Files are locked
while open, each person's work is committed as a session on the `content` branch, textures and models are
uploaded through the Project panel.

## Context

Two content people join, making levels and obstacles through the editor only. The editor was a Vite dev server
writing straight to `content/` on the machine it ran on: no login, whole-file saves, one person. Options:

- **Git for everyone** — each runs the editor locally, branch per person, PRs. Node, pnpm and git on two
  non-coders' machines, and merge conflicts on JSON documents that cannot be merged. Kodjo: "is there a better
  way." There is.
- **Host the editor** — the way Roblox Studio and Unity do it for artists: they open a URL.

## Decisions (Kodjo's, in order)

1. **Hosted, on a VPS**, not his PC: their work does not depend on it being awake. Hetzner CX23, ~5 €/month.
2. **Login is Cloudflare Access**, One-time PIN to an allow-listed email. No password code of ours; the server
   verifies the Access JWT with Node's `crypto`. Needed a domain on Cloudflare: `playgorbo.com`, bought for it
   (the game will live at the apex). MFA stays off — with email codes as the only method it would lock everyone
   out; Google login can be added later and MFA turned on then.
3. **Everyone equal.** No admin role, no force-unlock. Locks and history make mistakes recoverable.
4. **Locks per file, taken on open, stale after 2 minutes** without a heartbeat. The Perforce model: a level
   is one JSON document; the second person gets read-only rather than a conflict later. Lock-on-first-edit was
   offered and refused — two people mid-edit before either knows.
5. **Commits per session, on a `content` branch.** Commit when the lock is released, plus a safety commit
   every 10 minutes, authored by the person. Not per save (240 commits for an afternoon). Not to master: a
   finished-looking but bad stage must not be live the moment it is saved, and the box holding push rights to
   master is a risk. Kodjo merges `content` into master after playing it.
6. **Upload**: drop on a Project folder; `png jpg webp ktx2 glb` only (`.gltf` drags side files along); cap is
   a config value, 10 MB to start; same name replaces and keeps the id.

## Scrutiny that changed the plan

- **The server never pulls.** The first plan had it `pull --rebase` before pushing. Its working tree holds other
  people's uncommitted work at any moment; a rebase there is where files get eaten. It is the only writer to
  `content`, so it only pushes; a refused push is a warning in the editor, never a force.
- **Deploy commits first**, then merges master in. Otherwise the merge can meet a dirty content file.
- **State outside the repo**: `/var/lib/editor-server/` holds locks and the admin token. Never a commit.
- **`content/games/<game>.json`** is the one file both branches could write. It is not: adoption is the
  editor's, private components are `rules.ts` code. Rule: nobody hand-edits it on master. A union merge driver
  was offered as a belt and deferred until it bites.
- Kodjo edits content on the hosted editor too, or takes its lock by pointing his dev editor at it. The dev
  editor stays for development.

## Rejected

- A Save-and-push button in the local editor (git hidden, not gone). Still an install and a pull discipline.
- Tailscale as the login (free for three). No install on their side won.
- Trusting `Cf-Access-Authenticated-User-Email`. cloudflared is on loopback; only the JWT proves the edge.
- A gltf upload. A `.glb` is one file; a `.gltf` is a folder in disguise.

## Consequences

- The dev editor's `vite.config.ts` shrank to a plugin that mounts the shared API with `auth: none`.
- `assetOps.ts` and `assetImporter.ts` moved to the server package.
- `CONTRIBUTING.md` at the root is the second human-facing file (CLAUDE.md notes the exception).
- Kodjo's routine: pull, play, merge `content` into master, `pnpm deploy:editor` after editor or game changes.
