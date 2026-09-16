#!/usr/bin/env bash
# One-off content migration (ADR 0108): every game becomes a folder holding its own game.json and levels/.
# From your PC, after the code that reads the new layout is deployed:
#
#   ssh root@<box> bash -s < deploy/editor/migrate-layout.sh            (dry run: report only)
#   ssh root@<box> bash -s -- --write < deploy/editor/migrate-layout.sh (move, commit on content, push)
#
#   content/levels/keyboard2.json  ->  content/keyboard/levels/keyboard2.level.json
#   content/games/keyboard.json    ->  content/keyboard/game.json
#   content/assets/**              ->  unchanged (the shared library stays)
#
# Nothing inside any file changes: a level's folder is the game it already declares, so this is a pure rename
# and every move is verified byte-for-byte. Asset ids are untouched because a reference is an id, never a path
# (ADR 0026), so no level or prefab is rewritten. A level declaring no game is refused and named, and any
# refusal moves nothing at all.
#
# Idempotent: rerunning after a successful migration reports nothing to move and exits 0.
#
# The editor server is stopped while the files move: an open live level holds its own copy and would write it
# back to the old path. Sessions are committed first so the migration commit holds only the migration.
set -euo pipefail

APP_USER=editor
REPO=/srv/editor/repo
STATE=/var/lib/editor-server
CONFIG=/etc/editor-server/config.json
PORT=8080
WRITE="${1:-}"

cd "${REPO}"
run() { sudo -u "${APP_USER}" "$@"; }

if [[ "${WRITE}" == "--write" ]]; then
  echo "== flush sessions"
  if [[ -f "${STATE}/admin.token" ]] && curl -fsS -o /dev/null -X POST -H "Authorization: Bearer $(cat "${STATE}/admin.token")" "http://localhost:${PORT}/api/admin/commit-all"; then
    echo "every session committed"
  fi
  echo "== stop editor-server"
  systemctl stop editor-server
  trap 'systemctl start editor-server; echo "editor-server: $(systemctl is-active editor-server)"' EXIT
fi

echo "== migrate ${WRITE:-(dry run)}"
run "${REPO}/node_modules/.bin/tsx" tools/editor-server/src/migrateLayout.ts content ${WRITE}

if [[ "${WRITE}" == "--write" ]]; then
  echo "== commit on $(run git rev-parse --abbrev-ref HEAD)"
  NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${CONFIG}','utf8')).git?.committer?.name ?? 'Editor Server')")
  EMAIL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${CONFIG}','utf8')).git?.committer?.email ?? 'editor-server@localhost')")
  # Renames are an add and a delete until git pairs them, which `-A` covers; the content is identical, so it
  # pairs them as renames and the history of every level follows it into its game's folder.
  run git add -A -- content
  if run git -c "user.name=${NAME}" -c "user.email=${EMAIL}" commit --quiet -m "Give every game its own folder"; then
    run git push --quiet origin HEAD
    echo "committed and pushed $(run git rev-parse --short HEAD)"
  else
    echo "nothing to commit"
  fi
fi
