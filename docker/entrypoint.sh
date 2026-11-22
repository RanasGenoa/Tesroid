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
  chmod 755 "$tmp_dir"

  deb_file="$tmp_dir/google-chrome-stable_current_amd64.deb"
  curl --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 --retry 3 --retry-delay 2 -fsSL "$CHROME_DEB_URL" -o "$deb_file"

  if ! dpkg-deb --info "$deb_file" >/dev/null 2>&1; then
    echo "[entrypoint] ERROR: Downloaded file is not a valid Debian package." >&2
    exit 1
  fi

  DEBIAN_FRONTEND=noninteractive dpkg --configure -a || true
  apt-get -o Acquire::Retries=3 update -qq
  DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -qq -y --no-install-recommends "$deb_file"
  rm -rf "$tmp_dir" /var/lib/apt/lists/*
  trap - EXIT INT TERM
  echo "[entrypoint] Google Chrome installation completed."
fi

# 2. Configure WSL2 / Docker Desktop library path & auto-detect VAAPI device/driver
if [ -d /usr/lib/wsl/lib ]; then
  case ":${LD_LIBRARY_PATH:-}:" in
    *":/usr/lib/wsl/lib:"*) ;;
    *)
      export LD_LIBRARY_PATH="/usr/lib/wsl/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
      ;;
  esac
fi

trim_ws() {
  local val="$1"
  val="${val//$'\r'/}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  printf '%s' "$val"
}

raw_encoder_mode="$(trim_ws "${ENCODER_MODE:-auto}")"
case "${raw_encoder_mode,,}" in
  vaapi|software|auto)
    export ENCODER_MODE="${raw_encoder_mode,,}"
    ;;
  "")
    export ENCODER_MODE="auto"
    ;;
  *)
    echo "[entrypoint] WARN: Invalid ENCODER_MODE='${raw_encoder_mode}', falling back to 'auto'." >&2
    export ENCODER_MODE="auto"
    ;;
esac

detect_vaapi_device() {
  local preferred=""
  local non_nvidia=""
  local first_any=""
  local node=""
  local base=""
  local vendor_file=""
  local vendor=""

  for node in /dev/dri/renderD*; do
    [ -e "$node" ] || continue
    if [ -z "$first_any" ]; then
      first_any="$node"
    fi
    base="$(basename "$node")"
    vendor_file="/sys/class/drm/${base}/device/vendor"
    vendor=""
    if [ -r "$vendor_file" ]; then
      vendor="$(tr '[:upper:]' '[:lower:]' < "$vendor_file" 2>/dev/null | tr -d '[:space:]')"
    fi
    if [ "$vendor" = "0x8086" ] || [ "$vendor" = "0x1002" ]; then
      preferred="$node"
      break
    fi
    if [ "$vendor" != "0x10de" ] && [ -z "$non_nvidia" ]; then
      non_nvidia="$node"
    fi
  done

  if [ -n "$preferred" ]; then
    printf '%s' "$preferred"
  elif [ -n "$non_nvidia" ]; then
    printf '%s' "$non_nvidia"
  elif [ -n "$first_any" ]; then
    printf '%s' "$first_any"
  elif [ ! -e /dev/dxg ]; then
    printf '%s' "/dev/dri/renderD128"
  fi
}

probe_intel_vaapi_driver() {
  local dev="$1"
  local out=""
  if command -v vainfo >/dev/null 2>&1 && [ -n "$dev" ] && [ -e "$dev" ]; then
    out="$(timeout 3 env LIBVA_DRIVER_NAME=iHD vainfo --display drm --device "$dev" 2>/dev/null || true)"
    if printf '%s' "$out" | grep -q 'VAProfileH264' && printf '%s' "$out" | grep -q 'VAEntrypointEncSlice'; then
      printf 'iHD'
      return 0
    fi
    out="$(timeout 3 env LIBVA_DRIVER_NAME=i965 vainfo --display drm --device "$dev" 2>/dev/null || true)"
    if printf '%s' "$out" | grep -q 'VAProfileH264' && printf '%s' "$out" | grep -q 'VAEntrypointEncSlice'; then
      printf 'i965'
      return 0
    fi
    if timeout 3 env LIBVA_DRIVER_NAME=iHD vainfo --display drm --device "$dev" >/dev/null 2>&1; then
      printf 'iHD'
      return 0
    fi
    if timeout 3 env LIBVA_DRIVER_NAME=i965 vainfo --display drm --device "$dev" >/dev/null 2>&1; then
      printf 'i965'
      return 0
    fi
  fi
  printf 'iHD'
}

raw_vaapi_device="$(trim_ws "${VAAPI_DEVICE:-}")"
if [ -z "$raw_vaapi_device" ] || [ "${raw_vaapi_device,,}" = "auto" ]; then
  export VAAPI_DEVICE="$(detect_vaapi_device)"
else
  export VAAPI_DEVICE="$raw_vaapi_device"
fi

raw_libva_driver="$(trim_ws "${LIBVA_DRIVER_NAME:-}")"
if [ -z "$raw_libva_driver" ] || [ "${raw_libva_driver,,}" = "auto" ]; then
  if [ -e /dev/dxg ]; then
    export LIBVA_DRIVER_NAME="d3d12"
  elif [ -n "${VAAPI_DEVICE:-}" ]; then
    resolved_dev="$(readlink -f "$VAAPI_DEVICE" 2>/dev/null || printf '%s' "$VAAPI_DEVICE")"
    dev_vendor_file="/sys/class/drm/$(basename "$resolved_dev")/device/vendor"
    dev_vendor=""
    if [ -r "$dev_vendor_file" ]; then
      dev_vendor="$(tr '[:upper:]' '[:lower:]' < "$dev_vendor_file" 2>/dev/null | tr -d '[:space:]')"
    fi
    case "$dev_vendor" in
      0x1002)
        export LIBVA_DRIVER_NAME="radeonsi"
        ;;
      0x8086)
        export LIBVA_DRIVER_NAME="$(probe_intel_vaapi_driver "$VAAPI_DEVICE")"
        ;;
      *)
        export LIBVA_DRIVER_NAME="iHD"
        ;;
    esac
  else
    export LIBVA_DRIVER_NAME="iHD"
  fi
else
  export LIBVA_DRIVER_NAME="$raw_libva_driver"
fi

echo "[entrypoint] VAAPI config: ENCODER_MODE=${ENCODER_MODE}, VAAPI_DEVICE=${VAAPI_DEVICE:-<none>}, LIBVA_DRIVER_NAME=${LIBVA_DRIVER_NAME}"

# 3. Start cloudflared in the background when TUNNEL_TOKEN is provided
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

# 4. Launch application server
# Note: With `init: true` (tini) and `TINI_KILL_PROCESS_GROUP=1`, SIGTERM/SIGINT are forwarded to the entire process group.
cd /app/server
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
exec node dist/index.js
