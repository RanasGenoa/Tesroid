#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Tesroid ワンショット導入スクリプト (Intel / AMD x86_64 Linux 向け)
# ==============================================================================

IMAGE_NAME="ghcr.io/ranasgenoa/tesroid:latest"
DEFAULT_INSTALL_DIR="${HOME}/tesroid"
DEFAULT_PORT="9001"
MIN_RECOMMENDED_MEM_KB=$((1900 * 1024)) # 約 2GB (ハードウェア予約分を考慮)

# カラー出力設定 (TTY の場合のみ有効)
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  CYAN=''
  BOLD=''
  NC=''
fi

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# curl | bash 実行時でも /dev/tty から対話入力を受け取るヘルパー
read_input() {
  local prompt="$1"
  local var_name="$2"
  local input=""

  if [[ -r /dev/tty ]]; then
    read -r -p "$prompt" input </dev/tty
  else
    read -r -p "$prompt" input
  fi
  printf -v "$var_name" '%s' "$input"
}

confirm() {
  local prompt="$1"
  local default="${2:-N}"
  local reply=""

  read_input "$prompt" reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

# sudo 実行ラッパー
run_sudo() {
  if [[ $EUID -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    error "root 権限または sudo コマンドが必要です。"
    exit 1
  fi
}

echo -e "${BOLD}============================================================${NC}"
echo -e "${BOLD}  Tesroid ワンショット導入スクリプト${NC}"
echo -e "${BOLD}============================================================${NC}"
echo ""

# ------------------------------------------------------------------------------
# 1. 事前環境チェックと非対応環境の明示的ブロック
# ------------------------------------------------------------------------------
info "1/5 動作環境の事前チェックを実行しています..."

# OS チェック
OS_NAME="$(uname -s)"
if [[ "$OS_NAME" != "Linux" ]]; then
  error "非対応の OS です (${OS_NAME})。"
  error "Tesroid サーバーは Intel/AMD VAAPI を利用するため、Linux 環境専用です。"
  exit 1
fi

# アーキテクチャチェック (x86_64 のみ対応)
ARCH="$(uname -m)"
if [[ "$ARCH" != "x86_64" ]]; then
  error "非対応の CPU アーキテクチャです (${ARCH})。"
  error "Tesroid は x86_64 (amd64) 専用設計のため、ARM (arm64 / aarch64) 搭載の"
  error "Raspberry Pi や ARM NAS 等では動作しません。"
  exit 1
fi
ok "CPU アーキテクチャ: ${ARCH}"

# /dev/dri/renderD128 存在チェック (VAAPI GPU 必須)
if [[ ! -e /dev/dri/renderD128 ]]; then
  error "/dev/dri/renderD128 が見つかりません。"
  error "Tesroid は映像エンコードに Intel / AMD GPU の VAAPI (h264_vaapi) が必須です。"
  error "以下の環境では動作しないため、導入を中止します:"
  error "  - 格安 VPS / GPU なしのクラウド VM"
  error "  - Windows PC (Docker Desktop / WSL2)"
  error "  - Linux ホストで iGPU が無効化 (BIOS 設定等) されている環境"
  exit 1
fi
ok "VAAPI デバイスを確認: /dev/dri/renderD128"

# メモリ確認 (2GB 未満は警告)
if [[ -r /proc/meminfo ]]; then
  MEM_TOTAL_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  MEM_TOTAL_MB=$((MEM_TOTAL_KB / 1024))
  if (( MEM_TOTAL_KB < MIN_RECOMMENDED_MEM_KB )); then
    warn "システムメモリが約 ${MEM_TOTAL_MB} MB です（推奨: 2048 MB / 2GB 以上）。"
    warn "Google Chrome + FFmpeg + PulseAudio + Node.js の同時稼働により動作が不安定になる場合があります。"
    if ! confirm "このまま続行しますか？ [y/N]: " "N"; then
      info "導入をキャンセルしました。"
      exit 1
    fi
  else
    ok "システムメモリ: ${MEM_TOTAL_MB} MB"
  fi
fi

echo ""

# ------------------------------------------------------------------------------
# 2. Docker / Docker Compose 確認・導入
# ------------------------------------------------------------------------------
info "2/5 Docker / Docker Compose の状態を確認しています..."

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker がインストールされていません。"
  if confirm "公式スクリプト (https://get.docker.com) を使用して Docker を自動インストールしますか？ [Y/n]: " "Y"; then
    if ! command -v curl >/dev/null 2>&1; then
      if command -v apt-get >/dev/null 2>&1; then
        info "curl をインストールしています..."
        run_sudo apt-get update -y
        run_sudo apt-get install -y curl
      else
        error "curl が見つかりません。先に curl をインストールするか、Docker を手動で導入してください。"
        error "参考: https://docs.docker.com/engine/install/"
        exit 1
      fi
    fi

    info "Docker Engine をインストールしています..."
    curl -fsSL https://get.docker.com | run_sudo sh

    if command -v systemctl >/dev/null 2>&1; then
      run_sudo systemctl enable --now docker || true
    fi
    ok "Docker Engine のインストールが完了しました。"
  else
    error "Docker が必要です。公式手順に従いインストール後、再度実行してください:"
    error "  https://docs.docker.com/engine/install/"
    exit 1
  fi
else
  ok "Docker を確認: $(docker --version)"
fi

# Docker Compose v2 プラグイン確認
if ! docker compose version >/dev/null 2>&1; then
  warn "Docker Compose v2 (docker compose) が見つかりません。"
  if command -v apt-get >/dev/null 2>&1; then
    if confirm "docker-compose-plugin をインストールしますか？ [Y/n]: " "Y"; then
      run_sudo apt-get update -y
      run_sudo apt-get install -y docker-compose-plugin
      ok "Docker Compose v2 をインストールしました。"
    else
      error "Docker Compose v2 が必要です。インストール後に再実行してください。"
      exit 1
    fi
  else
    error "Docker Compose v2 が見つかりません。公式手順に従い docker-compose-plugin を導入してください。"
    exit 1
  fi
else
  ok "Docker Compose を確認: $(docker compose version)"
fi

# Docker デーモン起動確認
if ! run_sudo docker info >/dev/null 2>&1; then
  if command -v systemctl >/dev/null 2>&1; then
    info "Docker デーモンを起動しています..."
    run_sudo systemctl start docker
  fi
  if ! run_sudo docker info >/dev/null 2>&1; then
    error "Docker デーモンに接続できません。Docker サービスの状態を確認してください。"
    exit 1
  fi
fi

echo ""

# ------------------------------------------------------------------------------
# 3. GPU 権限設定 (render / video / docker グループ)
# ------------------------------------------------------------------------------
info "3/5 GPU および Docker のユーザー権限を設定しています..."

TARGET_USER="${SUDO_USER:-${USER:-$(id -un)}}"
GROUPS_TO_ADD=()
NEED_RELOGIN=false

if [[ "$TARGET_USER" != "root" ]]; then
  for grp in render video docker; do
    if getent group "$grp" >/dev/null 2>&1; then
      if ! id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx "$grp"; then
        GROUPS_TO_ADD+=("$grp")
      fi
    fi
  done

  if (( ${#GROUPS_TO_ADD[@]} > 0 )); then
    GROUP_LIST="$(IFS=,; echo "${GROUPS_TO_ADD[*]}")"
    info "ユーザー '${TARGET_USER}' をグループ (${GROUP_LIST}) に追加します..."
    run_sudo usermod -aG "$GROUP_LIST" "$TARGET_USER"
    NEED_RELOGIN=true
    ok "グループ追加完了: ${GROUP_LIST}"
  else
    ok "ユーザー '${TARGET_USER}' は必要なグループ (render/video/docker) に所属済みです。"
  fi
else
  ok "root ユーザーで実行中のためグループ追加はスキップします。"
fi

echo ""

# ------------------------------------------------------------------------------
# 4. 対話式セットアップ & docker-compose.yml / .env 生成・起動
# ------------------------------------------------------------------------------
info "4/5 対話式セットアップを開始します..."

# インストール先ディレクトリ
read_input "インストール先ディレクトリ [${DEFAULT_INSTALL_DIR}]: " INPUT_DIR
INSTALL_DIR="${INPUT_DIR:-$DEFAULT_INSTALL_DIR}"
# 先頭の ~/ を $HOME/ に展開
if [[ "$INSTALL_DIR" == "~" ]]; then
  INSTALL_DIR="$HOME"
elif [[ "$INSTALL_DIR" == "~/"* ]]; then
  INSTALL_DIR="${HOME}/${INSTALL_DIR#~/}"
fi

# 公開ポート
while true; do
  read_input "公開ポート番号 [${DEFAULT_PORT}]: " INPUT_PORT
  TESROID_PORT="${INPUT_PORT:-$DEFAULT_PORT}"
  if [[ "$TESROID_PORT" =~ ^[0-9]+$ ]] && (( TESROID_PORT >= 1 && TESROID_PORT <= 65535 )); then
    break
  fi
  warn "1〜65535 の数値を入力してください。"
done

# Cloudflare Tunnel トークン
echo ""
info "Cloudflare Tunnel を利用する場合、Zero Trust で取得した TUNNEL_TOKEN を入力してください。"
info "（ローカル検証や既存のリバースプロキシを使う場合は空欄のまま Enter でスキップできます）"
read_input "TUNNEL_TOKEN [空欄でスキップ]: " TUNNEL_TOKEN

mkdir -p "$INSTALL_DIR"

COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
ENV_FILE="${INSTALL_DIR}/.env"

if [[ -f "$COMPOSE_FILE" || -f "$ENV_FILE" ]]; then
  warn "${INSTALL_DIR} に既存の docker-compose.yml または .env が存在します。"
  if ! confirm "上書きして続行しますか？ [y/N]: " "N"; then
    info "既存ファイルを保護するため中止しました。"
    exit 1
  fi
fi

cat > "$ENV_FILE" <<EOF
# Tesroid Configuration
TESROID_PORT=${TESROID_PORT}
BROWSER_URL=https://www.youtube.com
DISPLAY_WIDTH=1280
DISPLAY_HEIGHT=720
FPS=30
VIDEO_BITRATE=1000k
VAAPI_DEVICE=/dev/dri/renderD128
LIBVA_DRIVER_NAME=iHD
TUNNEL_TOKEN=${TUNNEL_TOKEN}
EOF
chmod 600 "$ENV_FILE"

cat > "$COMPOSE_FILE" <<EOF
services:
  tesroid:
    image: ${IMAGE_NAME}
    container_name: tesroid-server
    init: true
    devices:
      - /dev/dri:/dev/dri
    shm_size: 1g
    ports:
      - "\${TESROID_PORT:-9001}:8080"
    volumes:
      - tesroid-data:/data
    environment:
      - PORT=8080
      - DATA_DIR=/data
      - NODE_ENV=production
      - BROWSER_URL=\${BROWSER_URL:-https://www.youtube.com}
      - DISPLAY_WIDTH=\${DISPLAY_WIDTH:-1280}
      - DISPLAY_HEIGHT=\${DISPLAY_HEIGHT:-720}
      - FPS=\${FPS:-30}
      - VIDEO_BITRATE=\${VIDEO_BITRATE:-1000k}
      - VAAPI_DEVICE=\${VAAPI_DEVICE:-/dev/dri/renderD128}
      - LIBVA_DRIVER_NAME=\${LIBVA_DRIVER_NAME:-iHD}
      - TUNNEL_TOKEN=\${TUNNEL_TOKEN:-}
    restart: unless-stopped

volumes:
  tesroid-data:
    driver: local
EOF

ok "設定ファイルを生成しました:"
echo "  - ${COMPOSE_FILE}"
echo "  - ${ENV_FILE}"
echo ""

info "Tesroid コンテナイメージを取得して起動しています..."
cd "$INSTALL_DIR"

if docker info >/dev/null 2>&1; then
  docker compose pull
  docker compose up -d
else
  # グループ追加直後などで現シェルから docker.sock にアクセスできない場合は sudo 経由で起動
  run_sudo docker compose pull
  run_sudo docker compose up -d
fi

ok "Tesroid コンテナを起動しました。"
echo ""

# ------------------------------------------------------------------------------
# 5. 完了案内 (アクセスURL・初期PIN設定・ログ確認コマンド)
# ------------------------------------------------------------------------------
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
HOST_IP="${HOST_IP:-127.0.0.1}"

echo -e "${BOLD}============================================================${NC}"
echo -e "${GREEN}${BOLD}  Tesroid のセットアップが完了しました！${NC}"
echo -e "${BOLD}============================================================${NC}"
echo ""
echo -e "${BOLD}■ 初回アクセス & 初期 PIN 設定:${NC}"
echo "  1. ブラウザで以下の URL にアクセスし、初期 PIN コードを設定してください。"
echo "     - ローカルアクセス: http://127.0.0.1:${TESROID_PORT}"
if [[ "$HOST_IP" != "127.0.0.1" ]]; then
  echo "     - LAN 内アクセス  : http://${HOST_IP}:${TESROID_PORT}"
fi
if [[ -n "$TUNNEL_TOKEN" ]]; then
  echo "     - Cloudflare Tunnel: Zero Trust で設定した公開 URL (https://<your-domain>)"
  echo "       ※ Public Hostname の転送先 (Service) には http://localhost:8080 を設定してください。"
else
  echo "     ※ テスラ車載ブラウザからの接続には公的 CA の HTTPS リバースプロキシが必要です。"
  echo "        設定方法は docs/NETWORK.md を参照してください。"
fi
echo ""
echo "  ※ 初回起動時はコンテナ内で Google Chrome を自動取得するため、"
echo "     アクセス可能になるまで 1〜2 分かかる場合があります。"
echo ""

if [[ "$NEED_RELOGIN" == true ]]; then
  echo -e "${YELLOW}■ グループ権限反映のお願い:${NC}"
  echo "  ユーザー '${TARGET_USER}' を render / video / docker グループに追加しました。"
  echo "  今後 sudo なしで docker コマンドを使うには、一度ログアウト＆再ログインするか、"
  echo "  以下を実行してください:"
  echo "    newgrp docker"
  echo ""
fi

echo -e "${BOLD}■ 動作確認・トラブルシューティング用コマンド:${NC}"
echo "  # 起動ログの確認 (エラー発生時はこちらを確認してください)"
echo "  cd ${INSTALL_DIR} && docker compose logs -f --tail 50"
echo ""
echo "  # ヘルスチェック"
echo "  curl -s http://127.0.0.1:${TESROID_PORT}/api/health"
echo ""
echo "  # コンテナ内 VAAPI ハードウェアアクセラレーション診断"
echo "  docker exec -it tesroid-server vainfo"
echo ""
