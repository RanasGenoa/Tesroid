#!/usr/bin/env bash
set -euo pipefail

# Capture and immediately remove TUNNEL_TOKEN so child processes never inherit it.
_tunnel_token="${TUNNEL_TOKEN:-}"
unset TUNNEL_TOKEN

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

to_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

validate_port() {
  local raw_port="$1"
  if [[ ! "$raw_port" =~ ^[0-9]+$ ]] || (( raw_port < 1 || raw_port > 65535 )); then
    echo "Invalid PORT: ${raw_port} (expected 1..65535)" >&2
    exit 1
  fi
}

validate_positive_int() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "Invalid ${name}: ${value} (expected positive integer)" >&2
    exit 1
  fi
}

PORT="$(trim_whitespace "${PORT:-8080}")"
validate_port "${PORT}"
export PORT

DATA_DIR="$(trim_whitespace "${DATA_DIR:-/data}")"
if [[ -z "${DATA_DIR}" ]]; then
  echo "DATA_DIR must not be empty" >&2
  exit 1
fi
mkdir -p "${DATA_DIR}"
export DATA_DIR

DISPLAY="$(trim_whitespace "${DISPLAY:-:99}")"
if [[ -z "${DISPLAY}" ]]; then
  echo "DISPLAY must not be empty" >&2
  exit 1
fi
export DISPLAY

LOCALE="$(trim_whitespace "${LOCALE:-ja-JP}")"
export LOCALE="${LOCALE:-ja-JP}"

TZ="$(trim_whitespace "${TZ:-Asia/Tokyo}")"
export TZ="${TZ:-Asia/Tokyo}"

BUFFER_HOLD_EXPIRE_MINUTES="$(trim_whitespace "${BUFFER_HOLD_EXPIRE_MINUTES:-10}")"
validate_positive_int "BUFFER_HOLD_EXPIRE_MINUTES" "${BUFFER_HOLD_EXPIRE_MINUTES}"
export BUFFER_HOLD_EXPIRE_MINUTES

raw_encoder_mode="$(trim_whitespace "${ENCODER_MODE:-auto}")"
normalized_encoder_mode="$(to_lower "${raw_encoder_mode}")"
case "${normalized_encoder_mode}" in
  auto|nvenc|vaapi|software)
    export ENCODER_MODE="${normalized_encoder_mode}"
    ;;
  *)
    echo "Invalid ENCODER_MODE: ${raw_encoder_mode} (expected auto|nvenc|vaapi|software)" >&2
    exit 1
    ;;
esac

# Preserve explicit driver/device settings only; leave unset when empty or "auto" for app probing.
if [[ -n "${LIBVA_DRIVER_NAME:-}" ]]; then
  trimmed_driver="$(trim_whitespace "${LIBVA_DRIVER_NAME}")"
  if [[ -z "${trimmed_driver}" || "$(to_lower "${trimmed_driver}")" == "auto" ]]; then
    unset LIBVA_DRIVER_NAME
  else
    export LIBVA_DRIVER_NAME="${trimmed_driver}"
  fi
else
  unset LIBVA_DRIVER_NAME
fi

if [[ -n "${VAAPI_DEVICE:-}" ]]; then
  trimmed_device="$(trim_whitespace "${VAAPI_DEVICE}")"
  if [[ -z "${trimmed_device}" || "$(to_lower "${trimmed_device}")" == "auto" ]]; then
    unset VAAPI_DEVICE
  else
    export VAAPI_DEVICE="${trimmed_device}"
  fi
else
  unset VAAPI_DEVICE
fi

# GALLIUM_DRIVER=d3d12 is scoped strictly to FFmpeg/vainfo subprocesses inside the server.
if [[ -n "${GALLIUM_DRIVER:-}" ]] && [[ "$(to_lower "${GALLIUM_DRIVER}")" == "d3d12" ]]; then
  unset GALLIUM_DRIVER
fi

install_chrome_if_missing() {
  if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1; then
    return 0
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  cleanup_chrome_tmp() {
    rm -rf "${tmp_dir}"
  }
  trap cleanup_chrome_tmp RETURN

  local deb_file="${tmp_dir}/google-chrome-stable_current_amd64.deb"
  echo "Downloading Google Chrome Stable (amd64) over TLS..."
  curl --proto '=https' --tlsv1.2 -fsSL \
    "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" \
    -o "${deb_file}"

  if ! dpkg-deb --info "${deb_file}" >/dev/null 2>&1; then
    echo "Downloaded Chrome package failed dpkg-deb integrity check" >&2
    return 1
  fi

  local pkg_name pkg_arch
  pkg_name="$(dpkg-deb --field "${deb_file}" Package || true)"
  pkg_arch="$(dpkg-deb --field "${deb_file}" Architecture || true)"
  if [[ "${pkg_name}" != "google-chrome-stable" || "${pkg_arch}" != "amd64" ]]; then
    echo "Unexpected Chrome package metadata: Package=${pkg_name} Architecture=${pkg_arch}" >&2
    return 1
  fi

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${deb_file}"
  rm -rf /var/lib/apt/lists/*

  if ! command -v google-chrome >/dev/null 2>&1 && ! command -v google-chrome-stable >/dev/null 2>&1; then
    echo "Google Chrome binary missing after installation" >&2
    return 1
  fi
}

install_chrome_if_missing

if [[ -n "${_tunnel_token}" ]]; then
  if [[ "${_tunnel_token}" =~ [[:space:][:cntrl:]] ]]; then
    unset _tunnel_token
    echo "Invalid TUNNEL_TOKEN format: whitespace or control characters are not allowed" >&2
    exit 1
  fi

  if ! command -v cloudflared >/dev/null 2>&1; then
    unset _tunnel_token
    echo "cloudflared binary not found in PATH" >&2
    exit 1
  fi

  (
    set +e
    TUNNEL_TOKEN="${_tunnel_token}" cloudflared tunnel --no-autoupdate run
    rc=$?
    if (( rc != 0 && rc != 130 && rc != 143 )); then
      echo "cloudflared exited unexpectedly with code ${rc}; please verify TUNNEL_TOKEN" >&2
    fi
  ) &
fi

unset _tunnel_token

if (( $# > 0 )); then
  exec "$@"
fi

exec node --input-type=module -e 'import { startServer } from "./server/dist/index.js"; startServer().catch((err) => { console.error(err); process.exit(1); });'
