#!/usr/bin/env bash
# One-time setup of the hosted editor box (ADR 0083). Run as root on a fresh Ubuntu 24.04+ server:
#
#   curl -fsSL https://raw.githubusercontent.com/IssayaGameDev/Multiplayer-Web/master/deploy/editor/setup.sh | bash -s -- git@github.com:IssayaGameDev/Multiplayer-Web.git
#
# or copy this file over and `bash setup.sh <repo ssh url>`. Idempotent: rerunning repairs, it does not duplicate.
#
# Assumes cloudflared is already installed as a service by the Cloudflare dashboard's tunnel command, routing
# editor.<domain> → http://localhost:8080. Nothing here opens a port.
set -euo pipefail

REPO_URL="${1:?usage: setup.sh <git ssh url>}"
BRANCH=content
PNPM_VERSION=10.32.1
APP_USER=editor
REPO=/srv/editor/repo
STATE=/var/lib/editor-server
CONF=/etc/editor-server/config.json

echo "== packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates > /dev/null

if ! command -v node > /dev/null || [[ "$(node -v | cut -c2-3)" -lt 22 ]]; then
  echo "== node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null
  apt-get install -y -qq nodejs > /dev/null
fi
echo "node $(node -v)"
corepack enable
corepack prepare "pnpm@${PNPM_VERSION}" --activate
echo "pnpm $(pnpm -v)"

echo "== user ${APP_USER}"
id -u "${APP_USER}" > /dev/null 2>&1 || useradd -m -s /bin/bash "${APP_USER}"
HOME_DIR=$(getent passwd "${APP_USER}" | cut -d: -f6)
mkdir -p "${HOME_DIR}/.ssh" && chmod 700 "${HOME_DIR}/.ssh"
if [[ ! -f "${HOME_DIR}/.ssh/id_ed25519" ]]; then
  sudo -u "${APP_USER}" ssh-keygen -q -t ed25519 -N '' -C "editor-server" -f "${HOME_DIR}/.ssh/id_ed25519"
fi
ssh-keyscan -t ed25519 github.com 2> /dev/null >> "${HOME_DIR}/.ssh/known_hosts"
sort -u -o "${HOME_DIR}/.ssh/known_hosts" "${HOME_DIR}/.ssh/known_hosts"
chown -R "${APP_USER}:${APP_USER}" "${HOME_DIR}/.ssh"

echo
echo "== deploy key — add this to GitHub → repo → Settings → Deploy keys, with 'Allow write access' ticked:"
echo
cat "${HOME_DIR}/.ssh/id_ed25519.pub"
echo
if ! sudo -u "${APP_USER}" ssh -o BatchMode=yes -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
  read -r -p "Press Enter once the key is added (Ctrl+C to stop here and rerun later)... " _
fi

echo "== checkout ${REPO} on ${BRANCH}"
mkdir -p "$(dirname "${REPO}")"
chown "${APP_USER}:${APP_USER}" "$(dirname "${REPO}")"
if [[ ! -d "${REPO}/.git" ]]; then
  sudo -u "${APP_USER}" git clone --quiet "${REPO_URL}" "${REPO}"
fi
cd "${REPO}"
sudo -u "${APP_USER}" git config user.name "Editor Server"
sudo -u "${APP_USER}" git config user.email "editor@playgorbo.com"
sudo -u "${APP_USER}" git fetch --quiet origin
if sudo -u "${APP_USER}" git show-ref --verify --quiet "refs/remotes/origin/${BRANCH}"; then
  sudo -u "${APP_USER}" git checkout --quiet "${BRANCH}"
else
  # First time: the content branch starts where master is.
  sudo -u "${APP_USER}" git checkout --quiet -b "${BRANCH}" origin/master
  sudo -u "${APP_USER}" git push --quiet -u origin "${BRANCH}"
fi

echo "== install + build editor"
sudo -u "${APP_USER}" pnpm install --frozen-lockfile --reporter=silent
sudo -u "${APP_USER}" pnpm --filter @mp/editor run build > /dev/null

echo "== config + state"
mkdir -p "$(dirname "${CONF}")" "${STATE}"
chown "${APP_USER}:${APP_USER}" "${STATE}"
chmod 700 "${STATE}"
if [[ ! -f "${CONF}" ]]; then
  cp deploy/editor/editor-server.config.example.json "${CONF}"
  echo "wrote ${CONF} from the example — edit auth.aud and auth.users before anyone logs in"
fi
chown root:"${APP_USER}" "${CONF}"
chmod 640 "${CONF}"

echo "== service"
cp deploy/editor/editor-server.service /etc/systemd/system/editor-server.service
systemctl daemon-reload
systemctl enable --quiet editor-server
systemctl restart editor-server
sleep 2
systemctl --no-pager --lines=5 status editor-server || true

cat <<EOF

Done. Next:
  1. nano ${CONF}   — set auth.users (email → display name). Leave aud empty for now.
  2. systemctl restart editor-server
  3. Open https://editor.<domain> once. The login is refused, and the log shows the audience tag:
       journalctl -u editor-server -n 20
     Put it in auth.aud, restart again. From then on everyone in auth.users gets in.
  4. Later deploys: from your PC,  pnpm deploy:editor
EOF
