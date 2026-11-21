#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Tesroid ワンショット導入スクリプト (Intel / AMD x86_64 Linux 向け)
# ==============================================================================

readonly IMAGE_NAME="ghcr.io/ranasgenoa/tesroid:latest"
readonly DEFAULT_PORT="9001"
readonly MIN_RECOMMENDED_MEM_KB=$((1900 * 1024)) # 約 2GB (ハードウェア予約分を考慮)

# カラー出力設定 (TTY の場合のみ有効)
if [[ -t 1 ]]; then
  readonly RED='\033[0;31m'
  readonly GREEN='\033[0;32m'
  readonly YELLOW='\033[1;33m'
  readonly CYAN='\033[0;36m'
  readonly BOLD='\033[1m'
  readonly NC='\033[0m'
else
  readonly RED=''
  readonly GREEN=''
  readonly YELLOW=''
  readonly CYAN=''
  readonly BOLD=''
  readonly NC=''
fi

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# 実行対象ユーザーとホームディレクトリの解決 (sudo 実行時にも元ユーザーを基準にする)
TARGET_USER="${SUDO_USER:-${USER:-$(id -un)}}"
if [[ "$TARGET_USER" != "root" ]] && getent passwd "$TARGET_USER" >/dev/null 2>&1; then
  TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
else
  TARGET_HOME="${HOME:-/root}"
fi
if [[ -z "$TARGET_HOME" ]]; then
  TARGET_HOME="${HOME:-/root}"
fi
readonly TARGET_USER
readonly TARGET_HOME
readonly DEFAULT_INSTALL_DIR="${TARGET_HOME}/tesroid"

# 状態保持用変数
NEED_RELOGIN=false
INSTALL_DIR=""
TESROID_PORT=""
TUNNEL_TOKEN=""
VAAPI_DEVICE="/dev/dri/renderD128"
LIBVA_DRIVER_NAME="iHD"
COMPOSE_FILE=""
ENV_FILE=""

# 前後の空白・タブ・改行を除去するヘルパー
trim_whitespace() {
  local val="$1"
  val="${val//$'\r'/}"
  val="${val//$'\n'/}"
  # 先頭と末尾の空白文字を除去
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  printf '%s' "$val"
}

# curl | bash 実行時でも /dev/tty から安全に対話入力を受け取るヘルパー
read_input() {
  local prompt="$1"
  local var_name="$2"
  local input=""

  if [[ -r /dev/tty ]]; then
    if ! read -r -p "$prompt" input </dev/tty; then
      input=""
    fi
  elif [[ -t 0 ]]; then
    if ! read -r -p "$prompt" input; then
      input=""
    fi
  else
    error "対話入力用の端末 (/dev/tty) が利用できません。対話可能なターミナルから実行してください。"
    exit 1
  fi
  printf -v "$var_name" '%s' "$input"
}

confirm() {
  local prompt="$1"
  local default="${2:-N}"
  local reply=""

  read_input "$prompt" reply
  reply="$(trim_whitespace "$reply")"
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

# GPU ベンダー ID から推奨 VAAPI ドライバ名を判定するヘルパー
detect_default_libva_driver() {
  local dev_name
  dev_name="$(basename "$VAAPI_DEVICE")"
  local vendor_file="/sys/class/drm/${dev_name}/device/vendor"

  if [[ -r "$vendor_file" ]]; then
    local vendor_id
    vendor_id="$(tr '[:upper:]' '[:lower:]' < "$vendor_file" 2>/dev/null | tr -d '[:space:]')"
    case "$vendor_id" in
      0x1002)
        echo "radeonsi"
        return
        ;;
      0x8086)
        echo "iHD"
        return
        ;;
    esac
  fi

  echo "iHD"
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

# ------------------------------------------------------------------------------
# 1. 事前環境チェックと非対応環境の明示的ブロック
# ------------------------------------------------------------------------------
check_environment() {
  info "1/5 動作環境の事前チェックを実行しています..."

  local os_name
  os_name="$(uname -s)"
  if [[ "$os_name" != "Linux" ]]; then
    error "非対応の OS です (${os_name})。"
    error "Tesroid サーバーは Intel / AMD VAAPI を利用するため、Linux 環境専用です。"
    exit 1
  fi

  local arch
  arch="$(uname -m)"
  if [[ "$arch" != "x86_64" ]]; then
    error "非対応の CPU アーキテクチャです (${arch})。"
    error "Tesroid は x86_64 (amd64) 専用設計のため、ARM (arm64 / aarch64) 搭載の"
    error "Raspberry Pi や ARM NAS 等では動作しません。"
    exit 1
  fi
  ok "CPU アーキテクチャ: ${arch}"

  if [[ -e /dev/dri/renderD128 ]]; then
    VAAPI_DEVICE="/dev/dri/renderD128"
    ok "VAAPI デバイスを確認: ${VAAPI_DEVICE}"
  else
    local fallback_render=""
    local candidate
    for candidate in /dev/dri/renderD*; do
      if [[ -e "$candidate" ]]; then
        fallback_render="$candidate"
        break
      fi
    done

    if [[ -n "$fallback_render" ]]; then
      VAAPI_DEVICE="$fallback_render"
      warn "/dev/dri/renderD128 が見つからないため、検出された ${VAAPI_DEVICE} を VAAPI デバイスとして使用します。"
    else
      error "/dev/dri/renderD* が見つかりません。"
      error "Tesroid は映像エンコードに Intel / AMD GPU の VAAPI (h264_vaapi) が必須です。"
      error "以下の環境では動作しないため、導入を中止します:"
      error "  - 格安 VPS / GPU なしのクラウド VM"
      error "  - Windows PC (Docker Desktop / WSL2)"
      error "  - Linux ホストで iGPU が無効化 (BIOS 設定等) されている環境"
      exit 1
    fi
  fi

  if [[ -r /proc/meminfo ]]; then
    local mem_total_kb
    mem_total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
    if [[ "$mem_total_kb" =~ ^[0-9]+$ ]]; then
      local mem_total_mb=$((mem_total_kb / 1024))
      if (( 10#$mem_total_kb < MIN_RECOMMENDED_MEM_KB )); then
        warn "システムメモリが約 ${mem_total_mb} MB です（推奨: 2048 MB / 2GB 以上）。"
        warn "Google Chrome + FFmpeg + PulseAudio + Node.js の同時稼働により動作が不安定になる場合があります。"
        if ! confirm "このまま続行しますか？ [y/N]: " "N"; then
          info "導入をキャンセルしました。"
          exit 1
        fi
      else
        ok "システムメモリ: ${mem_total_mb} MB"
      fi
    fi
  fi

  echo ""
}

# ------------------------------------------------------------------------------
# 2. Docker / Docker Compose 確認・導入
# ------------------------------------------------------------------------------
ensure_docker() {
  info "2/5 Docker / Docker Compose の状態を確認しています..."

  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker がインストールされていません。"
    if confirm "公式スクリプト (https://get.docker.com) を使用して Docker を自動インストールしますか？ [Y/n]: " "Y"; then
      if ! command -v curl >/dev/null 2>&1; then
        if command -v apt-get >/dev/null 2>&1; then
          info "curl をインストールしています..."
          run_sudo apt-get update -y
          run_sudo apt-get install -y curl ca-certificates
        else
          error "curl が見つかりません。先に curl をインストールするか、Docker を手動で導入してください。"
          error "参考: https://docs.docker.com/engine/install/"
          exit 1
        fi
      fi

      info "Docker Engine インストーラーを取得しています..."
      local tmp_script
      tmp_script="$(mktemp)"
      if ! curl --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 120 --retry 3 --retry-delay 2 -fsSL https://get.docker.com -o "$tmp_script"; then
        rm -f "$tmp_script"
        error "Docker インストールスクリプトの取得に失敗しました。"
        exit 1
      fi
      info "Docker Engine をインストールしています..."
      run_sudo sh "$tmp_script"
      rm -f "$tmp_script"

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

  if ! docker info >/dev/null 2>&1 && ! run_sudo docker info >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1; then
      info "Docker デーモンを起動しています..."
      run_sudo systemctl start docker
    fi
    if ! docker info >/dev/null 2>&1 && ! run_sudo docker info >/dev/null 2>&1; then
      error "Docker デーモンに接続できません。Docker サービスの状態を確認してください。"
      exit 1
    fi
  fi

  echo ""
}

# ------------------------------------------------------------------------------
# 3. GPU 権限設定 (render / video / docker グループ)
# ------------------------------------------------------------------------------
configure_permissions() {
  info "3/5 GPU および Docker のユーザー権限を設定しています..."

  local groups_to_add=()

  if [[ "$TARGET_USER" != "root" ]]; then
    local grp
    for grp in render video docker; do
      if getent group "$grp" >/dev/null 2>&1; then
        if ! id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx "$grp"; then
          groups_to_add+=("$grp")
        fi
      fi
    done

    if (( ${#groups_to_add[@]} > 0 )); then
      local group_list
      group_list="$(IFS=,; echo "${groups_to_add[*]}")"
      info "ユーザー '${TARGET_USER}' をグループ (${group_list}) に追加します..."
      run_sudo usermod -aG "$group_list" "$TARGET_USER"
      NEED_RELOGIN=true
      ok "グループ追加完了: ${group_list}"
    else
      ok "ユーザー '${TARGET_USER}' は必要なグループ (render/video/docker) に所属済みです。"
    fi
  else
    ok "root ユーザーで実行中のためグループ追加はスキップします。"
  fi

  echo ""
}

# ------------------------------------------------------------------------------
# 4. 対話式セットアップ入力とバリデーション
# ------------------------------------------------------------------------------
prompt_configuration() {
  info "4/5 対話式セットアップを開始します..."

  # インストール先ディレクトリの入力と安全性検証
  local input_dir=""
  while true; do
    read_input "インストール先ディレクトリ [${DEFAULT_INSTALL_DIR}]: " input_dir
    input_dir="$(trim_whitespace "$input_dir")"
    INSTALL_DIR="${input_dir:-$DEFAULT_INSTALL_DIR}"

    if [[ "$INSTALL_DIR" == "~" ]]; then
      INSTALL_DIR="$TARGET_HOME"
    elif [[ "$INSTALL_DIR" == "~/"* ]]; then
      INSTALL_DIR="${TARGET_HOME}/${INSTALL_DIR#~/}"
    fi

    # シェル特殊文字やクォート・変数展開文字を拒否
    if [[ "$INSTALL_DIR" =~ [\$\`\"\'\\\;\|\&\<\>] ]]; then
      warn "ディレクトリパスに使用できない特殊文字が含まれています。再度入力してください。"
      continue
    fi
    break
  done

  # 公開ポートの入力 (10# による 10 進数強制で先頭ゼロの 8 進数解釈エラーを防止)
  local input_port=""
  while true; do
    read_input "公開ポート番号 [${DEFAULT_PORT}]: " input_port
    input_port="$(trim_whitespace "$input_port")"
    TESROID_PORT="${input_port:-$DEFAULT_PORT}"
    if [[ "$TESROID_PORT" =~ ^[0-9]+$ ]] && (( 10#$TESROID_PORT >= 1 && 10#$TESROID_PORT <= 65535 )); then
      TESROID_PORT="$((10#$TESROID_PORT))"
      break
    fi
    warn "1〜65535 の数値を入力してください。"
  done

  # Cloudflare Tunnel トークンの入力と形式検証
  echo ""
  info "Cloudflare Tunnel を利用する場合、Zero Trust で取得した TUNNEL_TOKEN を入力してください。"
  info "（ローカル検証や既存のリバースプロキシを使う場合は空欄のまま Enter でスキップできます）"
  local raw_token=""
  while true; do
    read_input "TUNNEL_TOKEN [空欄でスキップ]: " raw_token
    raw_token="$(trim_whitespace "$raw_token")"
    # 前後のクォートが誤って含まれている場合は除去
    raw_token="${raw_token#\"}"
    raw_token="${raw_token%\"}"
    raw_token="${raw_token#\'}"
    raw_token="${raw_token%\'}"
    raw_token="$(trim_whitespace "$raw_token")"

    if [[ -z "$raw_token" ]]; then
      TUNNEL_TOKEN=""
      break
    fi

    # コマンド全体 (例: cloudflared service install eyJ...) を貼り付けた場合のガイド
    if [[ "$raw_token" =~ [[:space:]] ]]; then
      warn "空白が含まれています。コマンド全体ではなく、トークン文字列（eyJ...）のみを入力してください。"
      continue
    fi

    # Cloudflare Tunnel トークン形式 (標準 Base64 / Base64URL / JWT 互換文字のみ) の検証
    if [[ ! "$raw_token" =~ ^[A-Za-z0-9+/=_.-]{20,}$ ]]; then
      warn "TUNNEL_TOKEN の形式が正しくありません（英数字・記号 + / = _ . - のみ、20文字以上）。再度確認して入力してください。"
      continue
    fi

    TUNNEL_TOKEN="$raw_token"
    break
  done

  # VAAPI ドライバ名の確認 (GPU ベンダーから自動判定した値を既定値として提示)
  local default_driver
  default_driver="$(detect_default_libva_driver)"
  echo ""
  info "VAAPI ドライバ名を指定してください（通常は自動判定された既定値のまま Enter で問題ありません）。"
  info "（Intel 第6世代以降: iHD / 旧世代 Intel: i965 / AMD Radeon: radeonsi）"
  local input_driver=""
  while true; do
    read_input "LIBVA_DRIVER_NAME [${default_driver}]: " input_driver
    input_driver="$(trim_whitespace "$input_driver")"
    LIBVA_DRIVER_NAME="${input_driver:-$default_driver}"
    if [[ "$LIBVA_DRIVER_NAME" =~ ^[A-Za-z0-9_-]+$ ]]; then
      break
    fi
    warn "英数字・ハイフン・アンダースコアのみで入力してください（例: iHD, i965, radeonsi）。"
  done
}

# ------------------------------------------------------------------------------
# 設定ファイルの生成とコンテナ起動
# ------------------------------------------------------------------------------
write_config_and_start() {
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

  # .env は作成瞬間から 0600 権限になるよう既存ファイルを削除の上、サブシェル + umask 077 で書き込む
  rm -f "$ENV_FILE"
  (
    umask 077
    cat > "$ENV_FILE" <<EOF
# Tesroid Configuration
TESROID_PORT="${TESROID_PORT}"
BROWSER_URL="https://www.youtube.com"
DISPLAY_WIDTH=1280
DISPLAY_HEIGHT=720
FPS=30
VIDEO_BITRATE=1000k
VAAPI_DEVICE="${VAAPI_DEVICE}"
LIBVA_DRIVER_NAME="${LIBVA_DRIVER_NAME}"
TUNNEL_TOKEN="${TUNNEL_TOKEN}"
EOF
  )
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

  if [[ "$TARGET_USER" != "root" && $EUID -eq 0 ]]; then
    chown "${TARGET_USER}:$(id -gn "$TARGET_USER")" "$INSTALL_DIR" "$COMPOSE_FILE" "$ENV_FILE"
  fi

  ok "設定ファイルを生成しました:"
  echo "  - ${COMPOSE_FILE}"
  echo "  - ${ENV_FILE}"
  echo ""

  info "Tesroid コンテナイメージを取得して起動しています..."
  (
    cd "$INSTALL_DIR"
    if docker info >/dev/null 2>&1; then
      docker compose pull
      docker compose up -d
    else
      # グループ追加直後などで現シェルから docker.sock にアクセスできない場合は sudo 経由で起動
      run_sudo docker compose pull
      run_sudo docker compose up -d
    fi
  )

  ok "Tesroid コンテナを起動しました。"
  echo ""
}

# ------------------------------------------------------------------------------
# 5. 完了案内 (アクセスURL・初期PIN設定・ログ確認コマンド)
# ------------------------------------------------------------------------------
print_summary() {
  local host_ip
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  host_ip="${host_ip:-127.0.0.1}"

  echo -e "${BOLD}============================================================${NC}"
  echo -e "${GREEN}${BOLD}  Tesroid のセットアップが完了しました！${NC}"
  echo -e "${BOLD}============================================================${NC}"
  echo ""
  echo -e "${BOLD}■ 初回アクセス & 初期 PIN 設定:${NC}"
  echo "  1. ブラウザで以下の URL にアクセスし、初期 PIN コードを設定してください。"
  echo "     - ローカルアクセス: http://127.0.0.1:${TESROID_PORT}"
  if [[ "$host_ip" != "127.0.0.1" ]]; then
    echo "     - LAN 内アクセス  : http://${host_ip}:${TESROID_PORT}"
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
  echo "  cd \"${INSTALL_DIR}\" && docker compose logs -f --tail 50"
  echo ""
  echo "  # ヘルスチェック"
  echo "  curl -s http://127.0.0.1:${TESROID_PORT}/api/health"
  echo ""
  echo "  # コンテナ内 VAAPI ハードウェアアクセラレーション診断"
  echo "  docker exec -it tesroid-server vainfo"
  echo ""
}

main() {
  echo -e "${BOLD}============================================================${NC}"
  echo -e "${BOLD}  Tesroid ワンショット導入スクリプト${NC}"
  echo -e "${BOLD}============================================================${NC}"
  echo ""

  check_environment
  ensure_docker
  configure_permissions
  prompt_configuration
  write_config_and_start
  print_summary
}

main "$@"
