#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Labo-Flow — Dev mode orchestrator
#
# Starts all four services with hot-reload:
#   1. Clawith backend   (uvicorn --reload on :8008)
#   2. Clawith frontend  (vite on :3080)
#   3. RAGFlow           (docker compose on :8880)
#   4. AIPPT frontend    (vite on :5173, base=/ppt/)
#   5. NGINX             (unified entry on :3008)
#
# Writes PIDs to .data/pid/  and logs to .data/log/
# Stop everything with:  ./stop.sh
#
# Test mode (runs unit/integration tests without starting services):
#   ./dev.sh --test [pytest-args...]
#   ./dev.sh --test tests/test_playwright_client.py -v
# ─────────────────────────────────────────────────────────────
set -e

# Ensure Homebrew paths are available (macOS non-interactive shells may miss them)
for _brew_prefix in /opt/homebrew /usr/local; do
    [ -d "$_brew_prefix/bin" ] && export PATH="$_brew_prefix/bin:$_brew_prefix/sbin:$PATH"
done

ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── Test mode ────────────────────────────────────────────────
# Usage:  ./dev.sh --test [pytest-args...]
# Runs Clawith backend test suite without starting any services.
# Creates/reuses a Python 3.12 venv at Clawith/backend/.venv-test
if [ "${1:-}" = "--test" ]; then
    shift   # remaining args forwarded to pytest
    BACKEND_DIR="$ROOT/Clawith/backend"
    VENV="$BACKEND_DIR/.venv-test"

    echo -e "\033[0;36m[dev.sh --test]\033[0m Setting up test environment..."

    # Create venv with Python 3.12 if missing
    if [ ! -x "$VENV/bin/python" ]; then
        echo "  Creating .venv-test with Python 3.12 (via uv)..."
        uv venv --python 3.12 "$VENV"
    fi

    # Install/sync project deps (fast when up-to-date)
    uv pip install --python "$VENV/bin/python" -e "$BACKEND_DIR[dev]" --quiet

    # Install Playwright Chromium if not already present
    if ! "$VENV/bin/python" -c "
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    p.chromium.launch().close()
" 2>/dev/null; then
        echo "  Installing Playwright Chromium..."
        "$VENV/bin/python" -m playwright install chromium
    fi

    echo -e "\033[0;36m[dev.sh --test]\033[0m Running tests..."
    cd "$BACKEND_DIR"

    # Default: all Playwright/doc/integration tests; override by passing args
    if [ $# -eq 0 ]; then
        "$VENV/bin/python" -m pytest \
            tests/test_playwright_client.py \
            tests/test_doc_tools.py \
            tests/test_playwright_agent_integration.py \
            -v
    else
        "$VENV/bin/python" -m pytest "$@"
    fi
    exit $?
fi

DATA_DIR="$ROOT/.data"
PID_DIR="$DATA_DIR/pid"
LOG_DIR="$DATA_DIR/log"
mkdir -p "$PID_DIR" "$LOG_DIR"

# Load shared env
if [ -f "$ROOT/.env" ]; then
    set -a; source "$ROOT/.env"; set +a
else
    echo "⚠️  No .env found. Copy .env.example to .env first."
    exit 1
fi

: "${NGINX_PORT:=3008}"
: "${CLAWITH_FRONTEND_PORT:=3080}"
: "${CLAWITH_BACKEND_PORT:=8008}"
: "${RAGFLOW_PORT:=8880}"
: "${RAGFLOW_MCP_PORT:=9382}"
: "${AIPPT_PORT:=5173}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# ── Helpers ──────────────────────────────────────────────────
log() { echo -e "${CYAN}[dev.sh]${NC} $*"; }
ok()  { echo -e "  ${GREEN}✓${NC} $*"; }
err() { echo -e "  ${RED}✗${NC} $*"; }

wait_port() {
    local port=$1 name=$2 max=${3:-20}
    for i in $(seq 1 "$max"); do
        if curl -s -o /dev/null -m 1 "http://localhost:$port" 2>/dev/null \
           || (command -v lsof &>/dev/null && lsof -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1); then
            ok "$name ready on :$port (${i}s)"
            return 0
        fi
        sleep 1
    done
    err "$name failed to become ready on :$port within ${max}s"
    return 1
}

cleanup_port() {
    local port=$1
    if command -v lsof &>/dev/null; then
        lsof -ti:$port 2>/dev/null | xargs kill -9 2>/dev/null || true
    fi
}

# ── Pre-flight cleanup ───────────────────────────────────────
log "Cleaning up any previous processes..."
for pidfile in "$PID_DIR"/*.pid; do
    [ -f "$pidfile" ] && kill -9 "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
done
for port in $NGINX_PORT $CLAWITH_FRONTEND_PORT $CLAWITH_BACKEND_PORT $RAGFLOW_PORT $RAGFLOW_MCP_PORT $AIPPT_PORT; do
    cleanup_port "$port"
done
sleep 1

# ── 1. Clawith backend ───────────────────────────────────────
log "Starting Clawith backend on :$CLAWITH_BACKEND_PORT ..."
CLAWITH_DIR="$ROOT/Clawith"
if [ ! -d "$CLAWITH_DIR/backend/.venv" ]; then
    err "Clawith .venv missing. Run ./setup-all.sh first."
    exit 1
fi
cd "$CLAWITH_DIR/backend"
nohup env PYTHONUNBUFFERED=1 \
    JWT_SECRET_KEY="$JWT_SECRET_KEY" \
    DATABASE_URL="$DATABASE_URL" \
    PUBLIC_BASE_URL="$PUBLIC_BASE_URL" \
    RAGFLOW_MCP_URL="${RAGFLOW_MCP_URL:-http://localhost:$RAGFLOW_MCP_PORT/mcp}" \
    .venv/bin/uvicorn app.main:app \
        --host 0.0.0.0 --port "$CLAWITH_BACKEND_PORT" --reload \
    > "$LOG_DIR/clawith-backend.log" 2>&1 &
echo $! > "$PID_DIR/clawith-backend.pid"
cd "$ROOT"

# ── 2. Clawith frontend ──────────────────────────────────────
log "Starting Clawith frontend on :$CLAWITH_FRONTEND_PORT ..."
cd "$CLAWITH_DIR/frontend"
if [ ! -d "node_modules" ]; then
    err "Clawith frontend node_modules missing. Run ./setup-all.sh first."
    exit 1
fi
nohup node_modules/.bin/vite --host 0.0.0.0 --port "$CLAWITH_FRONTEND_PORT" \
    > "$LOG_DIR/clawith-frontend.log" 2>&1 &
echo $! > "$PID_DIR/clawith-frontend.pid"
cd "$ROOT"

# ── 3. RAGFlow (dev mode) ────────────────────────────────────
RAGFLOW_DIR="$ROOT/ragflow"
log "Starting RAGFlow base services (MySQL/Redis/MinIO/ES) via docker compose..."
# Start infrastructure dependencies only (no ragflow container)
docker compose -f "$RAGFLOW_DIR/docker/docker-compose-base.yml" --profile elasticsearch up -d \
    > "$LOG_DIR/ragflow-base.log" 2>&1 \
    || { err "RAGFlow base services failed. Check $LOG_DIR/ragflow-base.log"; exit 1; }

log "Waiting for Elasticsearch on :1200 ..."
for _i in $(seq 1 60); do
    if curl -s -o /dev/null -m 2 -u "elastic:infini_rag_flow" "http://localhost:1200/_cluster/health" 2>/dev/null; then
        ok "Elasticsearch ready (${_i}s)"; break
    fi
    sleep 1
done

log "Starting RAGFlow Python API on :9380 ..."
# Check python exists AND has packages installed (not empty venv)
if [ ! -f "$RAGFLOW_DIR/.venv/bin/python" ] || \
   ! "$RAGFLOW_DIR/.venv/bin/python" -c "import quart" 2>/dev/null; then
    log "RAGFlow .venv not ready — running uv sync (may take a moment)..."
    cd "$RAGFLOW_DIR"
    uv sync --python 3.12 --all-extras --quiet \
        > "$LOG_DIR/ragflow-uv-sync.log" 2>&1 \
        || { err "uv sync failed. Check $LOG_DIR/ragflow-uv-sync.log"; exit 1; }
    cd "$ROOT"
fi
cd "$RAGFLOW_DIR"
nohup env PYTHONPATH="$RAGFLOW_DIR" \
    HF_ENDPOINT=https://hf-mirror.com \
    CLAWITH_JWT_SECRET_KEY="$JWT_SECRET_KEY" \
    "$RAGFLOW_DIR/.venv/bin/python" api/ragflow_server.py \
    > "$LOG_DIR/ragflow-api.log" 2>&1 &
echo $! > "$PID_DIR/ragflow-api.pid"

log "Starting RAGFlow task executor (worker 0) ..."
nohup env PYTHONPATH="$RAGFLOW_DIR" \
    HF_ENDPOINT=https://hf-mirror.com \
    CLAWITH_JWT_SECRET_KEY="$JWT_SECRET_KEY" \
    "$RAGFLOW_DIR/.venv/bin/python" rag/svr/task_executor.py 0 \
    > "$LOG_DIR/ragflow-task-executor.log" 2>&1 &
echo $! > "$PID_DIR/ragflow-task-executor.pid"
cd "$ROOT"

log "Starting RAGFlow MCP server on :$RAGFLOW_MCP_PORT (mode=host) ..."
cd "$RAGFLOW_DIR"
nohup env PYTHONPATH="$RAGFLOW_DIR" \
    HF_ENDPOINT=https://hf-mirror.com \
    "$RAGFLOW_DIR/.venv/bin/python" mcp/server/server.py \
        --host=127.0.0.1 \
        --port="$RAGFLOW_MCP_PORT" \
        --base-url=http://127.0.0.1:9380 \
        --mode=host \
    > "$LOG_DIR/ragflow-mcp.log" 2>&1 &
echo $! > "$PID_DIR/ragflow-mcp.pid"
cd "$ROOT"

log "Starting RAGFlow web frontend on :$RAGFLOW_PORT ..."
RAGFLOW_WEB_DIR="$RAGFLOW_DIR/web"
if [ ! -f "$RAGFLOW_WEB_DIR/node_modules/.bin/vite" ]; then
    log "RAGFlow web node_modules not ready — running npm install..."
    cd "$RAGFLOW_WEB_DIR"
    npm install --silent > "$LOG_DIR/ragflow-npm-install.log" 2>&1 \
        || { err "RAGFlow npm install failed. Check $LOG_DIR/ragflow-npm-install.log"; exit 1; }
    cd "$ROOT"
fi
cd "$RAGFLOW_WEB_DIR"
nohup env PORT="$RAGFLOW_PORT" npm run dev \
    > "$LOG_DIR/ragflow-web.log" 2>&1 &
echo $! > "$PID_DIR/ragflow-web.pid"
cd "$ROOT"

# ── 4. AIPPT ─────────────────────────────────────────────────
log "Starting AIPPT on :$AIPPT_PORT ..."
AIPPT_DIR="$ROOT/aippt"
cd "$AIPPT_DIR"
if [ ! -d "node_modules" ]; then
    err "AIPPT node_modules missing. Run: cd aippt && pnpm install"
    exit 1
fi
# Pass base=/ppt/ via env so NGINX subpath works, and expose port via PORT env
nohup env \
    PORT="$AIPPT_PORT" \
    VITE_BASE=/ppt/ \
    VITE_JWT_SECRET="$JWT_SECRET_KEY" \
    VITE_CUSTOM_LLM_URL="$VITE_CUSTOM_LLM_URL" \
    VITE_CUSTOM_API_KEY="$VITE_CUSTOM_API_KEY" \
    VITE_CUSTOM_MODEL="$VITE_CUSTOM_MODEL" \
    pnpm dev --host 0.0.0.0 \
    > "$LOG_DIR/aippt.log" 2>&1 &
echo $! > "$PID_DIR/aippt.pid"
cd "$ROOT"

# ── Wait for upstreams ───────────────────────────────────────
log "Waiting for upstream services..."
wait_port "$CLAWITH_BACKEND_PORT"  "Clawith backend"  30 || true
wait_port "$CLAWITH_FRONTEND_PORT" "Clawith frontend" 20 || true
wait_port "$RAGFLOW_PORT"          "RAGFlow"          180 || true
wait_port "$RAGFLOW_MCP_PORT"      "RAGFlow MCP"      30  || true
wait_port "$AIPPT_PORT"            "AIPPT"            20 || true

# ── 5. NGINX ─────────────────────────────────────────────────
log "Starting NGINX on :$NGINX_PORT ..."
if ! command -v nginx &>/dev/null; then
    err "nginx not found. Install with: brew install nginx  (macOS)  or  apt install nginx  (Linux)"
    err "Individual services are still running. Kill them with ./stop.sh"
    exit 1
fi

# Start nginx in foreground-capable daemon mode with our config
cd "$ROOT"
nohup nginx -p "$ROOT" -c "$ROOT/nginx.conf" -g 'daemon off;' \
    > "$LOG_DIR/nginx.log" 2>&1 &
echo $! > "$PID_DIR/nginx.pid"
sleep 1
wait_port "$NGINX_PORT" "NGINX" 10 || true

# ── Summary ──────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  🦞 Labo-Flow dev environment is up${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Unified entry:${NC}   http://localhost:$NGINX_PORT"
echo -e "  ${CYAN}Knowledge Base:${NC}  http://localhost:$NGINX_PORT/rag/"
echo -e "  ${CYAN}AI PPT:${NC}          http://localhost:$NGINX_PORT/ppt/"
echo ""
echo -e "  ${CYAN}Direct access (debugging):${NC}"
echo -e "    Clawith frontend  http://localhost:$CLAWITH_FRONTEND_PORT"
echo -e "    Clawith backend   http://localhost:$CLAWITH_BACKEND_PORT/api/health"
echo -e "    RAGFlow           http://localhost:$RAGFLOW_PORT"
echo -e "    RAGFlow MCP       http://localhost:$RAGFLOW_MCP_PORT/mcp  (server-to-server)"
echo -e "    AIPPT             http://localhost:$AIPPT_PORT"
echo ""
echo -e "  Logs:   tail -f $LOG_DIR/*.log"
echo -e "  Stop:   ./stop.sh"
echo ""
