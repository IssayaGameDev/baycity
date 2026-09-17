#!/usr/bin/env bash
# One-off content repair (ADR 0124): relink levels that carry a prefab definition instead of a reference.
# From your PC, after the code is deployed:
#
#   ssh root@<box> bash -s < deploy/editor/fix-inline-prefabs.sh            (dry run: report only)
#   ssh root@<box> bash -s -- --write < deploy/editor/fix-inline-prefabs.sh (rewrite, commit on content, push)
#
# `level.prefabs` is a resolution table: contents in memory, reference on disk. A definition that reached disk
# is read *instead of* the asset from then on, so the placement looks linked — badge, overrides, Open — and
# silently stops following its prefab. ADR 0124 stopped new ones being written; this is for the files that
# already have one.
#
# Only the `prefabs` table is touched. No node, no override, no id: the placements already reference the right
# asset, so dropping the entry is enough. Each rewrite is read back and refused unless the table is the only
# difference, which restores the file and exits non-zero.
#
# An entry with no asset behind it is KEPT and named: there the table genuinely is the only source, and
# dropping it would turn a placement that draws something into one that draws nothing.
#
# A dropped entry that had drifted from its asset changes what that level looks like — that is the point, and
# the only visible effect. The dry run counts them, so run it first and read the list.
#
# Idempotent: rerunning after a successful repair reports nothing to drop and exits 0.
#
# The editor server is stopped while the files change: an open live level holds its own copy and would write
# the table straight back. Sessions are committed first so the repair commit holds only the repair.
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

echo "== repair ${WRITE:-(dry run)}"
run "${REPO}/node_modules/.bin/tsx" tools/editor-server/src/fixInlinePrefabs.ts content ${WRITE}

if [[ "${WRITE}" == "--write" ]]; then
  echo "== commit on $(run git rev-parse --abbrev-ref HEAD)"
  NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${CONFIG}','utf8')).git?.committer?.name ?? 'Editor Server')")
  EMAIL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${CONFIG}','utf8')).git?.committer?.email ?? 'editor-server@localhost')")
  run git add -A -- content
  if run git -c "user.name=${NAME}" -c "user.email=${EMAIL}" commit --quiet -m "Relink levels that carried a prefab definition"; then
    run git push --quiet origin HEAD
    echo "committed and pushed $(run git rev-parse --short HEAD)"
  else
    echo "nothing to commit"
  fi
fi
