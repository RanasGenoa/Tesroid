#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Tesroid Remote Deployment Script
# ==============================================================================
# Runs local unit tests, synchronizes source files to a remote Docker host via
# rsync/SSH, rebuilds and restarts the container, and verifies health.
#
# Supported modes (DEPLOY_MODE):
#   - compose (default): Standard Linux / VPS host using `docker compose up -d --build`
#   - truenas          : TrueNAS SCALE Custom App using `docker build` + `midclt`
#
# Usage:
#   DEPLOY_HOST=192.168.1.100 ./scripts/deploy.sh
#   ./scripts/deploy.sh --skip-test
#   ./scripts/deploy.sh --logs
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load environment variables from .env if present
if [ -f "${ROOT_DIR}/.env" ]; then
  # shellcheck disable=SC1091
  set -a
  source "${ROOT_DIR}/.env"
  set +a
fi

DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
DEPLOY_PASS="${DEPLOY_PASS:-}"
REMOTE_DIR="${REMOTE_DIR:-/opt/tesroid}"
DEPLOY_MODE="${DEPLOY_MODE:-compose}"
TESROID_PORT="${TESROID_PORT:-9001}"
CONTAINER_NAME="${CONTAINER_NAME:-tesroid-server}"
TRUENAS_APP_NAME="${TRUENAS_APP_NAME:-tesroid}"
TRUENAS_IMAGE_NAME="${TRUENAS_IMAGE_NAME:-tesroid-tesroid:latest}"

if [ -z "$DEPLOY_HOST" ]; then
  echo "❌ Error: DEPLOY_HOST is not set."
  echo "   Define DEPLOY_HOST in .env (gitignored) or pass it via environment variable:"
  echo "   DEPLOY_HOST=192.168.1.100 ./scripts/deploy.sh"
  exit 1
fi

SKIP_TEST=false
FOLLOW_LOGS=false
CLEAN_DATA=false

for arg in "$@"; do
  case "$arg" in
    --skip-test)
      SKIP_TEST=true
      ;;
    --logs)
      FOLLOW_LOGS=true
      ;;
    --clean-data)
      CLEAN_DATA=true
      ;;
    *)
      ;;
  esac
done

# Configure SSH / rsync transport (SSH key auth by default; sshpass if DEPLOY_PASS is set)
if [ -n "$DEPLOY_PASS" ]; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  export SSH_AUTH_SOCK=""
  if ! command -v sshpass &> /dev/null; then
    echo "❌ Error: DEPLOY_PASS is set, but 'sshpass' is not installed."
    exit 1
  fi
  RSYNC_RSH="sshpass -p '${DEPLOY_PASS}' ssh -p ${DEPLOY_PORT} -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no -o PreferredAuthentications=password -o ConnectTimeout=10"
  run_ssh() {
    sshpass -p "${DEPLOY_PASS}" ssh -p "${DEPLOY_PORT}" -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no -o PreferredAuthentications=password -o ConnectTimeout=10 "${DEPLOY_USER}@${DEPLOY_HOST}" "$@"
  }
else
  RSYNC_RSH="ssh -p ${DEPLOY_PORT} -o ConnectTimeout=10"
  run_ssh() {
    ssh -p "${DEPLOY_PORT}" "${DEPLOY_USER}@${DEPLOY_HOST}" "$@"
  }
fi

echo "========================================================"
echo "🚀 Tesroid Remote Deployer (mode: ${DEPLOY_MODE})"
echo "   Target Host: ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PORT}"
echo "   Remote Path: ${REMOTE_DIR}"
echo "========================================================"

# Step 1: Pre-deploy verification
if [ "$SKIP_TEST" = false ]; then
  echo ""
  echo "🧪 [1/4] Running automated tests locally..."
  (cd "${ROOT_DIR}" && npm test)
else
  echo "⏩ [1/4] Skipping automated tests (--skip-test specified)."
fi

# Step 2: Sync source code to remote host
echo ""
echo "📦 [2/4] Syncing source code to ${DEPLOY_HOST}:${REMOTE_DIR}..."
run_ssh "mkdir -p '${REMOTE_DIR}'"

rsync -avz \
  --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.DS_Store' \
  --exclude='.env' \
  --exclude='*PRIVATE*' \
  --exclude='*private*' \
  --exclude='*.local*' \
  --exclude='data' \
  --exclude='server/data' \
  --exclude='.cache' \
  --exclude='coverage' \
  -e "${RSYNC_RSH}" \
  "${ROOT_DIR}/" \
  "${DEPLOY_USER}@${DEPLOY_HOST}:${REMOTE_DIR}/"

echo "✅ Source code synchronized."

# Step 3: Build & Restart container
echo ""
echo "🔨 [3/4] Building and restarting service (mode: ${DEPLOY_MODE})..."

if [ "$DEPLOY_MODE" = "truenas" ]; then
  poll_truenas_job() {
    local job_id="$1"
    echo "   Polling TrueNAS job ID: ${job_id}..."
    while true; do
      local state
      state=$(run_ssh "midclt call core.get_jobs '[[\"id\", \"=\", ${job_id}]]' | python3 -c \"import sys, json; data = json.load(sys.stdin); print(data[0]['state'] if data else 'UNKNOWN')\"")
      echo "     Current job state: ${state}"
      if [ "${state}" = "SUCCESS" ]; then
        echo "     Job ${job_id} succeeded."
        break
      elif [ "${state}" = "FAILED" ]; then
        local error_msg
        error_msg=$(run_ssh "midclt call core.get_jobs '[[\"id\", \"=\", ${job_id}]]' | python3 -c \"import sys, json; data = json.load(sys.stdin); print(data[0].get('error', 'Unknown error'))\"")
        echo "     ❌ Job ${job_id} failed: ${error_msg}"
        exit 1
      fi
      sleep 3
    done
  }

  echo "   Building container image ${TRUENAS_IMAGE_NAME}..."
  run_ssh "cd '${REMOTE_DIR}' && docker build -t '${TRUENAS_IMAGE_NAME}' ."

  echo "   Stopping TrueNAS app '${TRUENAS_APP_NAME}'..."
  STOP_JOB_ID=$(run_ssh "midclt call app.stop '${TRUENAS_APP_NAME}'")
  poll_truenas_job "${STOP_JOB_ID}"

  if [ "$CLEAN_DATA" = true ]; then
    echo "   🧹 Backing up and cleaning persistent data directory..."
    BACKUP_TS="$(date +%Y%m%d%H%M%S)"
    run_ssh "
      if [ -d /mnt/SSD/tesroid-data ]; then
        cp -a /mnt/SSD/tesroid-data /mnt/SSD/tesroid-data.bak-${BACKUP_TS} 2>/dev/null || true
        find /mnt/SSD/tesroid-data -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
        echo '     Data backed up to /mnt/SSD/tesroid-data.bak-${BACKUP_TS} and cleaned.'
      fi
    "
  fi

  echo "   Starting TrueNAS app '${TRUENAS_APP_NAME}'..."
  START_JOB_ID=$(run_ssh "midclt call app.start '${TRUENAS_APP_NAME}'")
  poll_truenas_job "${START_JOB_ID}"
else
  if [ "$CLEAN_DATA" = true ]; then
    echo "   🧹 Cleaning existing container data..."
    run_ssh "cd '${REMOTE_DIR}' && docker compose down -v 2>/dev/null || true"
  fi
  run_ssh "cd '${REMOTE_DIR}' && docker compose up -d --build"
fi

# Step 4: Verification & Health Check
echo ""
echo "🩺 [4/4] Verifying health endpoint with retries..."
RETRIES=15
DELAY=3
HEALTH_CHECK_PASSED=false

for i in $(seq 1 $RETRIES); do
  if run_ssh "curl -sf http://127.0.0.1:${TESROID_PORT}/api/health" > /dev/null 2>&1; then
    echo "✅ Health check passed on attempt $i!"
    HEALTH_CHECK_PASSED=true
    break
  fi
  echo "   Attempt $i/$RETRIES: service not ready yet, retrying in ${DELAY}s..."
  sleep $DELAY
done

if [ "$HEALTH_CHECK_PASSED" = false ]; then
  echo "❌ Error: Health check failed after $RETRIES attempts."
  echo "📋 Container logs (${CONTAINER_NAME}):"
  run_ssh "docker logs --tail 30 '${CONTAINER_NAME}' || true"
  exit 1
fi

echo ""
echo "📋 Latest 15 lines from ${CONTAINER_NAME} container logs:"
run_ssh "docker logs --tail 15 '${CONTAINER_NAME}' || true"

echo ""
echo "📋 System Status (/api/status):"
run_ssh "curl -s http://127.0.0.1:${TESROID_PORT}/api/status || true"
echo ""

echo ""
echo "========================================================"
echo "🎉 Deployment completed successfully!"
echo "   WebUI URL (local): http://${DEPLOY_HOST}:${TESROID_PORT}/"
echo "========================================================"

if [ "$FOLLOW_LOGS" = true ]; then
  echo "📜 Following logs (Ctrl+C to exit)..."
  run_ssh "docker logs -f --tail 30 '${CONTAINER_NAME}'"
fi
