#!/usr/bin/env bash
# One-off content change (ADR 0151, step 4): one storage for what a placement adds. What ADR 0130 kept on a
# placement's own node moves into its prefab root's record, where the editor writes it now — children always,
# components when the prefab's root has none of that type (the rest stay, named in the report). Empty record
# fields are tidied. Nothing anyone sees changes: every level must resolve exactly as before, or it is refused.
#
# From your PC, AFTER pushing the commit that adds this script. Today's code and the code before it both read
# either shape, so it can run before or after a deploy:
#
#   ssh root@<box> bash -s < deploy/editor/migrate-one-storage.sh            (dry run: report only)
#   ssh root@<box> bash -s -- --write < deploy/editor/migrate-one-storage.sh (migrate, commit on content, push)
#
# The tool runs from a throwaway checkout of origin/master, because the box's own checkout only gets it at the
# next deploy. It needs nothing from node_modules but the tsx binary. What it changes is the box's content.
#
# The editor server is stopped while the files change: an open live level holds its own copy and would write
# the old shape straight back. Sessions are committed first so the commit holds only this change.
set -euo pipefail

APP_USER=editor
REPO=/srv/editor/repo
STATE=/var/lib/editor-server
CONFIG=/etc/editor-server/config.json
PORT=8080
WRITE="${1:-}"

cd "${REPO}"
run() { sudo -u "${APP_USER}" "$@"; }

echo "== check out origin/master beside the repo"
run git fetch --quiet origin master
SCRATCH=$(run mktemp -d)
TREE="${SCRATCH}/master"
run git worktree add --quiet --detach "${TREE}" origin/master
cleanup() {
  run git worktree remove --force "${TREE}" || true
  run git worktree prune || true
  rm -rf "${SCRATCH}"
  if [[ "${WRITE}" == "--write" ]]; then
    systemctl start editor-server
    echo "editor-server: $(systemctl is-active editor-server)"
  fi
}
trap cleanup EXIT
if [[ ! -f "${TREE}/tools/editor-server/src/migrateOneStorage.ts" ]]; then
  echo "origin/master has no migrateOneStorage.ts yet: push first" >&2
  exit 1
fi

if [[ "${WRITE}" == "--write" ]]; then
  echo "== flush sessions"
  if [[ -f "${STATE}/admin.token" ]] && curl -fsS -o /dev/null -X POST -H "Authorization: Bearer $(cat "${STATE}/admin.token")" "http://localhost:${PORT}/api/admin/commit-all"; then
    echo "every session committed"
  fi
  echo "== stop editor-server"
  systemctl stop editor-server
fi

echo "== migrate ${WRITE:-(dry run)}"
run "${REPO}/node_modules/.bin/tsx" "${TREE}/tools/editor-server/src/migrateOneStorage.ts" content ${WRITE}

if [[ "${WRITE}" == "--write" ]]; then
  echo "== commit on $(run git rev-parse --abbrev-ref HEAD)"
  NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${CONFIG}','utf8')).git?.committer?.name ?? 'Editor Server')")
  EMAIL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${CONFIG}','utf8')).git?.committer?.email ?? 'editor-server@localhost')")
  run git add -A -- content
  if run git -c "user.name=${NAME}" -c "user.email=${EMAIL}" commit --quiet -m "Keep what each placement adds in its records"; then
    run git push --quiet origin HEAD
    echo "committed and pushed $(run git rev-parse --short HEAD)"
  else
    echo "nothing to commit"
  fi
fi
