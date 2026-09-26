#!/usr/bin/env bash
# One-off content change (ADR 0171): Parkour's and Swing's folders out of the content — their levels and their
# game.json. The games' code is gone; this takes what is left of them on the box. From your PC, any time after
# pushing the commit that adds this script:
#
#   ssh root@<box> bash -s < deploy/editor/remove-parkour-swing.sh            (dry run: lists what would go)
#   ssh root@<box> bash -s -- --write < deploy/editor/remove-parkour-swing.sh (remove, commit on content, push)
#
# The editor server is stopped while the folders go: an open live level holds its own copy and would write itself
# straight back. Sessions are committed first so the commit holds only this change. Idempotent: a rerun finds
# nothing left and changes nothing.
set -euo pipefail

APP_USER=editor
REPO=/srv/editor/repo
STATE=/var/lib/editor-server
CONFIG=/etc/editor-server/config.json
PORT=8080
WRITE="${1:-}"
GONE=(content/parkour content/swing)

cd "${REPO}"
run() { sudo -u "${APP_USER}" "$@"; }

BRANCH=$(run git rev-parse --abbrev-ref HEAD)
if [[ "${BRANCH}" != "content" ]]; then
  echo "the box's checkout is on ${BRANCH}, not content: stopping" >&2
  exit 1
fi

present=()
for dir in "${GONE[@]}"; do
  if [[ -e "${dir}" ]]; then present+=("${dir}"); fi
done
if [[ ${#present[@]} -eq 0 ]]; then
  echo "nothing left to remove"
  exit 0
fi

echo "== would remove"
for dir in "${present[@]}"; do find "${dir}" -type f | sort | sed 's/^/  /'; done
if [[ "${WRITE}" != "--write" ]]; then
  echo "(dry run: rerun with -- --write)"
  exit 0
fi

echo "== flush sessions"
if [[ -f "${STATE}/admin.token" ]] && curl -fsS -o /dev/null -X POST -H "Authorization: Bearer $(cat "${STATE}/admin.token")" "http://localhost:${PORT}/api/admin/commit-all"; then
  echo "every session committed"
fi
echo "== stop editor-server"
systemctl stop editor-server
trap 'systemctl start editor-server; echo "editor-server: $(systemctl is-active editor-server)"' EXIT

echo "== remove"
run git rm -r --quiet --ignore-unmatch -- "${present[@]}"
run rm -rf -- "${present[@]}"

echo "== commit on ${BRANCH}"
NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${CONFIG}','utf8')).git?.committer?.name ?? 'Editor Server')")
EMAIL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${CONFIG}','utf8')).git?.committer?.email ?? 'editor-server@localhost')")
if run git -c "user.name=${NAME}" -c "user.email=${EMAIL}" commit --quiet -m "Take Parkour and Swing out of the content"; then
  run git push --quiet origin HEAD
  echo "committed and pushed $(run git rev-parse --short HEAD)"
else
  echo "nothing to commit"
fi
