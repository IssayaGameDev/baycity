#!/usr/bin/env bash
# Redeploy the hosted editor with what is on master (ADR 0083). From your PC:
#
#   pnpm deploy:editor          (= ssh root@<box> bash -s < deploy/editor/update.sh)
#
# Order matters: every open session is committed first so the merge never meets a dirty content file; then
# master is merged into the content branch, dependencies installed, the editor rebuilt, the service restarted
# (SIGTERM commits again, harmlessly), and the merged branch pushed. Locks live outside the repo and survive.
#
# One-off content migrations are their own scripts, not steps here: `migrate-layout.sh`, `migrate-motion.sh`,
# `migrate-primitives.sh`, `migrate-prefab-refs.sh`, `strip-motion.sh`. Each runs once, by hand, and a deploy
# is not the place to keep checking whether it already has.
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

echo "== install + build"
run pnpm install --frozen-lockfile --reporter=silent
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
