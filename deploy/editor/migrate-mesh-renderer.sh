#!/usr/bin/env bash
# One-off content change (ADR 0153): one Mesh Renderer. Every Mesh folds into the Renderer beside it, as its
# model; placement records that name a prefab piece's Mesh move onto its Renderer. Prefab files and levels
# together, all or nothing. Nothing anyone sees changes: every file must draw exactly as before, or nothing is
# written and what stands in the way is named.
#
# On the box, AFTER the deploy that carries this script — the deployed code reads both shapes, so the editor and
# the game draw the same before and after:
#
#   bash /srv/editor/repo/deploy/editor/migrate-mesh-renderer.sh            (dry run: report only)
#   bash /srv/editor/repo/deploy/editor/migrate-mesh-renderer.sh --write    (fold, commit on content, push)
#
# It runs from the box's own checkout, which has what it needs installed. The editor server is stopped while
# the files change: an open live level holds its own copy and would write the old shape straight back.
# Sessions are committed first so the commit holds only this change.
set -euo pipefail

APP_USER=editor
REPO=/srv/editor/repo
STATE=/var/lib/editor-server
CONFIG=/etc/editor-server/config.json
PORT=8080
WRITE="${1:-}"
TOOL=tools/editor-server/src/migrateMeshRenderer.ts

cd "${REPO}"
run() { sudo -u "${APP_USER}" "$@"; }

if [[ ! -f "${TOOL}" ]]; then
  echo "the box has no ${TOOL} yet: push, deploy, then run this" >&2
  exit 1
fi

if [[ "${WRITE}" == "--write" ]]; then
  echo "== flush sessions"
  if [[ -f "${STATE}/admin.token" ]] && curl -fsS -o /dev/null -X POST -H "Authorization: Bearer $(cat "${STATE}/admin.token")" "http://localhost:${PORT}/api/admin/commit-all"; then
    echo "every session committed"
  fi
  echo "== stop editor-server"
  systemctl stop editor-server
  trap 'systemctl start editor-server; echo "editor-server: $(systemctl is-active editor-server)"' EXIT
fi

echo "== fold ${WRITE:-(dry run)}"
run "${REPO}/node_modules/.bin/tsx" "${TOOL}" content ${WRITE}

if [[ "${WRITE}" == "--write" ]]; then
  echo "== commit on $(run git rev-parse --abbrev-ref HEAD)"
  NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${CONFIG}','utf8')).git?.committer?.name ?? 'Editor Server')")
  EMAIL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${CONFIG}','utf8')).git?.committer?.email ?? 'editor-server@localhost')")
  run git add -A -- content
  if run git -c "user.name=${NAME}" -c "user.email=${EMAIL}" commit --quiet -m "Fold each Mesh into its Mesh Renderer"; then
    run git push --quiet origin HEAD
    echo "committed and pushed $(run git rev-parse --short HEAD)"
  else
    echo "nothing to commit"
  fi
fi
