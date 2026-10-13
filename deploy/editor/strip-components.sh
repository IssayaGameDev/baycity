#!/usr/bin/env bash
# One-off content change: take every component of the named types out of the content — Mover and Spinner (ADR 0137),
# StageGate and Checkpoint (ADR 0217). Deleted, not converted. From your PC, AFTER pushing the commit that has the
# tool and BEFORE the code that removes the types reaches master, which cannot load a file that still names them:
#
#   ssh root@<box> bash -s -- StageGate,Checkpoint < deploy/editor/strip-components.sh          (dry run: report only)
#   ssh root@<box> bash -s -- StageGate,Checkpoint --write < deploy/editor/strip-components.sh  (strip, commit on content, push)
#
# The tool runs from a throwaway checkout of origin/master, because the box's own checkout only gets it at the
# next deploy. It needs nothing from node_modules but the tsx binary. What it strips is the box's content.
#
# What goes: every component of the types in levels, prefab files and a level's resolution table; every record a
# placement keeps about one (its parameters, its switch, its removal, the component itself when the placement
# added it); the names from each game's shared list. Each rewrite is read back and refused unless nothing of the
# types is left, which restores the file and exits non-zero. Idempotent: a rerun reports nothing left.
#
# The editor server is stopped while the files change: an open live level holds its own copy and would write
# the components straight back. Sessions are committed first so the commit holds only this change.
set -euo pipefail

APP_USER=editor
REPO=/srv/editor/repo
STATE=/var/lib/editor-server
CONFIG=/etc/editor-server/config.json
PORT=8080
TYPES="${1:-}"
WRITE="${2:-}"

if [[ ! "${TYPES}" =~ ^[A-Za-z][A-Za-z0-9]*(,[A-Za-z][A-Za-z0-9]*)*$ ]]; then
  echo "usage: bash -s -- <Type[,Type…]> [--write]" >&2
  exit 2
fi

cd "${REPO}"
run() { sudo -u "${APP_USER}" "$@"; }

BRANCH=$(run git rev-parse --abbrev-ref HEAD)
if [[ "${BRANCH}" != "content" ]]; then
  echo "the box's checkout is on ${BRANCH}, not content: stopping" >&2
  exit 1
fi

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
if [[ ! -f "${TREE}/tools/editor-server/src/stripComponents.ts" ]]; then
  echo "origin/master has no stripComponents.ts yet: push first" >&2
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

echo "== strip ${TYPES} ${WRITE:-(dry run)}"
run "${REPO}/node_modules/.bin/tsx" "${TREE}/tools/editor-server/src/stripComponents.ts" content "${TYPES}" ${WRITE}

if [[ "${WRITE}" == "--write" ]]; then
  echo "== commit on ${BRANCH}"
  NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${CONFIG}','utf8')).git?.committer?.name ?? 'Editor Server')")
  EMAIL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${CONFIG}','utf8')).git?.committer?.email ?? 'editor-server@localhost')")
  run git add -A -- content
  if run git -c "user.name=${NAME}" -c "user.email=${EMAIL}" commit --quiet -m "Take ${TYPES//,/, } out of the content"; then
    run git push --quiet origin HEAD
    echo "committed and pushed $(run git rev-parse --short HEAD)"
  else
    echo "nothing to commit"
  fi
fi
