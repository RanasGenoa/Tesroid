#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" || "${TESROID_INSTALL_SKIP_START:-0}" == "1" ]]; then
  DRY_RUN=1
fi

check_platform() {
  local os_name arch_name
  os_name="$(uname -s)"
  arch_name="$(uname -m)"

  if [[ "${os_name}" != "Linux" ]]; then
    echo "Unsupported OS: ${os_name}. Tesroid install.sh supports Linux x86_64 (amd64) only." >&2
    exit 1
  fi

  if [[ "${arch_name}" != "x86_64" ]]; then
    echo "Unsupported architecture: ${arch_name}. Tesroid requires x86_64 (linux/amd64); ARM64/Raspberry Pi is not supported." >&2
    exit 1
  fi
}

check_memory() {
  if [[ ! -r /proc/meminfo ]]; then
    return 0
  fi

  local mem_kb mem_mb
  mem_kb="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo)"
  if [[ -n "${mem_kb}" ]]; then
    mem_mb=$(( mem_kb / 1024 ))
    if (( mem_mb < 2048 )); then
      echo "Warning: Detected ${mem_mb} MiB RAM. At least 2048 MiB (2 GB) is recommended." >&2
      local confirm="y"
      if [[ -t 0 ]]; then
        read -r -p "Continue anyway? [y/N]: " confirm
      fi
      if [[ ! "${confirm}" =~ ^[Yy]$ ]]; then
        echo "Installation cancelled." >&2
        exit 1
      fi
    fi
  fi
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed. Please install Docker Engine and Docker Compose v2 first." >&2
    exit 1
  fi

  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose v2 ('docker compose') is required." >&2
    exit 1
  fi
}

detect_gpu_profile() {
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -qi "nvidia"; then
      echo "nvidia"
      return 0
    fi
    echo "Note: NVIDIA GPU detected, but Docker nvidia runtime was not detected; checking VAAPI fallback." >&2
  fi

  local render_node
  for render_node in /dev/dri/renderD*; do
    if [[ -e "${render_node}" ]]; then
      echo "vaapi"
      return 0
    fi
  done

  echo "software"
}

check_dri_group_permissions() {
  local node="/dev/dri/renderD128"
  if [[ ! -e "${node}" ]]; then
    for candidate in /dev/dri/renderD*; do
      if [[ -e "${candidate}" ]]; then
        node="${candidate}"
        break
      fi
    done
  fi
  if [[ ! -e "${node}" ]]; then
    return 0
  fi

  local group_name
  group_name="$(stat -c '%G' "${node}" 2>/dev/null || true)"
  if [[ -n "${group_name}" ]] && ! id -nG | tr ' ' '\n' | grep -qx "${group_name}"; then
    echo "Info: Current user is not in group '${group_name}' for ${node}."
    if command -v usermod >/dev/null 2>&1 && (( EUID == 0 )); then
      usermod -aG "${group_name}" "${SUDO_USER:-$USER}" || true
    else
      echo "Run 'sudo usermod -aG ${group_name} \$USER' if rootless Docker cannot access ${node}."
    fi
  fi
}

validate_tunnel_token() {
  local token="$1"
  if [[ -z "${token}" ]]; then
    return 0
  fi
  if [[ "${#token}" -lt 20 ]] || [[ "${token}" =~ [[:space:][:cntrl:]] ]] || [[ ! "${token}" =~ ^[A-Za-z0-9_=.-]+$ ]]; then
    return 1
  fi
  return 0
}

prompt_inputs() {
  local default_port="9001"
  local default_tz="Asia/Tokyo"
  local default_locale="ja-JP"

  TESROID_PORT="${default_port}"
  TZ="${default_tz}"
  LOCALE="${default_locale}"
  TUNNEL_TOKEN=""

  if [[ -t 0 ]]; then
    local input_port input_tz input_locale input_token
    read -r -p "Host port [9001]: " input_port
    TESROID_PORT="${input_port:-${default_port}}"

    read -r -p "Timezone [Asia/Tokyo]: " input_tz
    TZ="${input_tz:-${default_tz}}"

    read -r -p "Browser locale [ja-JP]: " input_locale
    LOCALE="${input_locale:-${default_locale}}"

    read -r -s -p "Cloudflare TUNNEL_TOKEN (optional, input hidden): " input_token
    echo ""
    TUNNEL_TOKEN="${input_token:-}"
  fi

  if [[ ! "${TESROID_PORT}" =~ ^[0-9]+$ ]] || (( TESROID_PORT < 1 || TESROID_PORT > 65535 )); then
    echo "Invalid host port: ${TESROID_PORT}" >&2
    exit 1
  fi

  if ! validate_tunnel_token "${TUNNEL_TOKEN}"; then
    echo "Invalid TUNNEL_TOKEN format." >&2
    exit 1
  fi
}

write_env_file() {
  local gpu_profile="$1"
  local encoder_mode="auto"
  if [[ "${gpu_profile}" == "nvidia" ]]; then
    encoder_mode="nvenc"
  fi

  (
    umask 077
    cat > .env <<EOF
TESROID_PORT=${TESROID_PORT}
PORT=8080
DATA_DIR=/data
DISPLAY=:99
LOCALE=${LOCALE}
TZ=${TZ}
ENCODER_MODE=${encoder_mode}
VAAPI_DEVICE=
LIBVA_DRIVER_NAME=
TUNNEL_TOKEN=${TUNNEL_TOKEN}
TELEMETRY_LOG_DIR=
BUFFER_HOLD_EXPIRE_MINUTES=10
EOF
  )
  chmod 0600 .env
}

write_compose_file() {
  local gpu_profile="$1"

  cat > docker-compose.yml <<'EOF'
services:
  tesroid:
    image: ghcr.io/ranasgenoa/tesroid:latest
    platform: linux/amd64
    init: true
    shm_size: "1g"
    restart: unless-stopped
    ports:
      - "${TESROID_PORT:-9001}:${PORT:-8080}"
    volumes:
      - tesroid-data:/data
    environment:
      PORT: "${PORT:-8080}"
      DATA_DIR: "${DATA_DIR:-/data}"
      DISPLAY: "${DISPLAY:-:99}"
      LOCALE: "${LOCALE:-ja-JP}"
      TZ: "${TZ:-Asia/Tokyo}"
      ENCODER_MODE: "${ENCODER_MODE:-auto}"
      VAAPI_DEVICE: "${VAAPI_DEVICE:-}"
      LIBVA_DRIVER_NAME: "${LIBVA_DRIVER_NAME:-}"
      TUNNEL_TOKEN: "${TUNNEL_TOKEN:-}"
      TELEMETRY_LOG_DIR: "${TELEMETRY_LOG_DIR:-}"
      BUFFER_HOLD_EXPIRE_MINUTES: "${BUFFER_HOLD_EXPIRE_MINUTES:-10}"
      TINI_KILL_PROCESS_GROUP: "1"
EOF

  if [[ "${gpu_profile}" == "vaapi" ]]; then
    cat >> docker-compose.yml <<'EOF'
    devices:
      - "/dev/dri:/dev/dri"
EOF
  elif [[ "${gpu_profile}" == "nvidia" ]]; then
    cat >> docker-compose.yml <<'EOF'
      NVIDIA_VISIBLE_DEVICES: "${NVIDIA_VISIBLE_DEVICES:-all}"
      NVIDIA_DRIVER_CAPABILITIES: "${NVIDIA_DRIVER_CAPABILITIES:-video,compute,utility}"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu, video, compute, utility]
EOF
  fi

  cat >> docker-compose.yml <<'EOF'

volumes:
  tesroid-data:
EOF
}

main() {
  check_platform
  check_memory
  check_docker

  local gpu_profile
  gpu_profile="$(detect_gpu_profile)"
  echo "Detected GPU profile: ${gpu_profile}"
  if [[ "${gpu_profile}" == "vaapi" ]]; then
    check_dri_group_permissions
  fi

  prompt_inputs
  write_env_file "${gpu_profile}"
  write_compose_file "${gpu_profile}"
  unset TUNNEL_TOKEN

  if (( DRY_RUN == 1 )); then
    echo "Dry run complete: generated .env (0600) and docker-compose.yml."
    return 0
  fi

  docker compose pull
  docker compose up -d
  echo "Tesroid started. Health check: http://127.0.0.1:${TESROID_PORT}/api/health"
}

main "$@"
