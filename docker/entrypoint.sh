#!/usr/bin/env bash
set -euo pipefail

CHROME_DEB_URL="https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"

# 1. Install Google Chrome Stable on first start if not already present
if ! command -v google-chrome-stable >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1; then
  echo "[entrypoint] Google Chrome is not installed. Downloading google-chrome-stable..."
  tmp_dir="$(mktemp -d)"
  cleanup_tmp() {
    rm -rf "$tmp_dir"
  }
  trap cleanup_tmp EXIT INT TERM

  deb_file="$tmp_dir/google-chrome-stable_current_amd64.deb"
  curl --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 --retry 3 --retry-delay 2 -fsSL "$CHROME_DEB_URL" -o "$deb_file"

  if ! dpkg-deb --info "$deb_file" >/dev/null 2>&1; then
    echo "[entrypoint] ERROR: Downloaded file is not a valid Debian package." >&2
    exit 1
  fi

  apt-get -o Acquire::Retries=3 update -qq
  DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -qq -y --no-install-recommends "$deb_file"
  rm -rf "$tmp_dir" /var/lib/apt/lists/*
  trap - EXIT INT TERM
  echo "[entrypoint] Google Chrome installation completed."
fi

# 2. Start cloudflared in the background when TUNNEL_TOKEN is provided
if [ -n "${TUNNEL_TOKEN:-}" ]; then
  echo "[entrypoint] Starting cloudflared tunnel..."
  # Pass TUNNEL_TOKEN via environment variable (not CLI arguments) to avoid /proc/<pid>/cmdline exposure,
  # then unset it immediately so Node.js / Google Chrome child processes do not inherit the token.
  (
    set +e
    cloudflared tunnel --no-autoupdate run
    exit_code=$?
    if [ "$exit_code" -ne 0 ] && [ "$exit_code" -ne 130 ] && [ "$exit_code" -ne 143 ]; then
      echo "[entrypoint] ERROR: cloudflared exited unexpectedly (code: ${exit_code}). Please check TUNNEL_TOKEN." >&2
    fi
  ) &
  unset TUNNEL_TOKEN
fi

# 3. Launch application server
# Note: With `init: true` (tini) and `TINI_KILL_PROCESS_GROUP=1`, SIGTERM/SIGINT are forwarded to the entire process group.
cd /app/server
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
exec node dist/index.js
