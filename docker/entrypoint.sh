#!/usr/bin/env bash
set -euo pipefail

# Install Google Chrome Stable if not already present in the container
if ! command -v google-chrome-stable >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1; then
  echo "[entrypoint] Google Chrome is not installed. Downloading google-chrome-stable..."
  tmp_dir="$(mktemp -d)"
  cleanup_tmp() {
    rm -rf "$tmp_dir"
  }
  trap cleanup_tmp EXIT INT TERM

  deb_file="$tmp_dir/google-chrome-stable_current_amd64.deb"
  curl --retry 3 --retry-delay 2 -fsSL "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" -o "$deb_file"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -qq -y --no-install-recommends "$deb_file"
  rm -rf "$tmp_dir" /var/lib/apt/lists/*
  trap - EXIT INT TERM
  echo "[entrypoint] Google Chrome installation completed."
fi

# Start cloudflared in the background when TUNNEL_TOKEN is provided
if [ -n "${TUNNEL_TOKEN:-}" ]; then
  echo "[entrypoint] Starting cloudflared tunnel..."
  cloudflared tunnel --no-autoupdate run --token "$TUNNEL_TOKEN" &
fi

# init: true (tini) により、コンテナ停止時はプロセスツリー全体に SIGTERM が転送・回収されます
cd /app/server
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
exec node dist/index.js
