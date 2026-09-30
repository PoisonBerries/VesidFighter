#!/usr/bin/env bash
# One-time setup for a fresh Debian/Ubuntu VM (e.g. a Google Cloud free-tier
# e2-micro). Installs Node + Caddy, runs the game server as a systemd
# service, and has Caddy terminate TLS (GitHub Pages is HTTPS, so browsers
# require wss://).
#
# Usage (on the VM):  sudo bash setup-vm.sh <hostname> [repo-url]
#   <hostname>: a DNS name pointing at this VM, e.g. 34-56-78-90.sslip.io
set -euo pipefail

HOST="${1:?usage: setup-vm.sh <hostname> [repo-url]}"
REPO="${2:-https://github.com/remersong/VesidFighterMP.git}"
APP_DIR=/opt/vesidfighter

apt-get update -y
apt-get install -y curl git debian-keyring debian-archive-keyring apt-transport-https gnupg

# Node 22
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy (automatic HTTPS)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# e2-micro has 1 GB RAM; a little swap keeps npm/apt from OOMing.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# App code
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
(cd "$APP_DIR/server" && npm install --omit=dev)
id -u vesid >/dev/null 2>&1 || useradd --system --no-create-home vesid

cat > /etc/systemd/system/vesidfighter.service <<EOF
[Unit]
Description=Vesid Fighter game server
After=network.target

[Service]
User=vesid
WorkingDirectory=$APP_DIR/server
Environment=PORT=8080
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$HOST {
  reverse_proxy 127.0.0.1:8080
}
EOF

systemctl daemon-reload
systemctl enable --now vesidfighter
systemctl restart vesidfighter
systemctl restart caddy

echo
echo "Done. Game server URL: wss://$HOST"
