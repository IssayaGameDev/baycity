#!/usr/bin/env bash
# Redeploy the hosted editor with what is on master (ADR 0083). From your PC:
#
#   pnpm deploy:editor          (= ssh root@<box> bash -s < deploy/editor/update.sh)
#
# Order matters: every open session is committed first so the merge never meets a dirty content file; then
# master is merged into the content branch, dependencies installed, the content layout migrated with the
# server stopped (ADR 0108, idempotent), the editor rebuilt, the services restarted (SIGTERM commits again,
# harmlessly), and the merged branch pushed. Locks live outside the repo and survive.
set -euo pipefail

APP_USER=editor
REPO=/srv/editor/repo
STATE=/var/lib/editor-server
PORT=8080

echo "== flush sessions"
if [[ -f "${STATE}/admin.token" ]] && curl -fsS -o /dev/null -X POST -H "Authorization: Bearer $(cat "${STATE}/admin.token")" "http://localhost:${PORT}/api/admin/commit-all"; then
  echo "every session committed"
else
  echo "server not answering — nothing to flush"
fi

cd "${REPO}"
run() { sudo -u "${APP_USER}" "$@"; }

echo "== merge master into $(run git rev-parse --abbrev-ref HEAD)"
run git fetch --quiet origin master
if ! run git merge --quiet --no-edit origin/master; then
  echo "merge failed — resolve by hand in ${REPO} (git status), then rerun" >&2
  run git merge --abort || true
  exit 1
fi

echo "== install"
run pnpm install --frozen-lockfile --reporter=silent

# The content layout migration (ADR 0108): the new code looks for levels in `content/<game>/levels/` and this
# is what puts them there, so the box never serves new code against the old layout — which would show an
# editor with no levels in it.
#
# The server is stopped first: an open live level holds its own copy and would write it straight back to the
# old path. The restart below brings it up again, so there is nothing to undo on the way out.
#
# Idempotent — once the content is migrated it reports nothing to move and exits 0 — so it stays here for the
# same reason the other migrations have their own scripts: a box, or a fresh clone of an older `content`
# branch, corrects itself on the next deploy rather than needing someone to remember.
echo "== stop editor-server for the content migration"
systemctl stop editor-server
echo "== migrate content layout"
run "${REPO}/node_modules/.bin/tsx" tools/editor-server/src/migrateLayout.ts content --write

echo "== build"
run pnpm --filter @mp/editor run build > /dev/null

echo "== restart"
for unit in editor-server mp-relay mp-game-keyboard; do
  cp "deploy/editor/${unit}.service" "/etc/systemd/system/${unit}.service"
done
systemctl daemon-reload
systemctl restart editor-server mp-relay mp-game-keyboard
sleep 3
for unit in editor-server mp-relay mp-game-keyboard; do echo "${unit}: $(systemctl is-active "${unit}")"; done

echo "== push content"
run git push --quiet origin HEAD
echo "deployed $(run git rev-parse --short HEAD)"
