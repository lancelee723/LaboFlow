#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Labo-Flow — Dev mode orchestrator
#
# Starts all four services with hot-reload:
#   1. Clawith backend   (uvicorn --reload on :8008)
#   2. Clawith frontend  (vite on :3080)
#   3. LightRAG server   (lightrag-server on :9621)
#   4. AIPPT frontend    (vite on :5173, base=/ppt/)
#   5. NGINX             (unified entry on :3008)
#
# Writes PIDs to .data/pid/  and logs to .data/log/
# Stop everything with:  ./stop.sh
# ─────────────────────────────────────────────────────────────
set -e

# Ensure Homebrew paths are available (macOS non-interactive shells may miss them)
for _brew_prefix in /opt/homebrew /usr/local; do
    [ -d "$_brew_prefix/bin" ] && export PATH="$_brew_prefix/bin:$_brew_prefix/sbin:$PATH"
done

ROOT="$(cd "$(dirname "$0")" && pwd)"
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
: "${LIGHTRAG_PORT:=9621}"
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
for port in $NGINX_PORT $CLAWITH_FRONTEND_PORT $CLAWITH_BACKEND_PORT $LIGHTRAG_PORT $AIPPT_PORT; do
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

# ── 3. LightRAG ──────────────────────────────────────────────
log "Starting LightRAG server on :$LIGHTRAG_PORT ..."
LIGHTRAG_DIR="$ROOT/LightRAG"
cd "$LIGHTRAG_DIR"
if [ ! -f ".env" ]; then
    err "LightRAG .env missing. Run ./setup-all.sh first."
    exit 1
fi
# lightrag-server reads config from .env in CWD
nohup env \
    HOST=0.0.0.0 \
    PORT="$LIGHTRAG_PORT" \
    TOKEN_SECRET="$JWT_SECRET_KEY" \
    JWT_ALGORITHM="$JWT_ALGORITHM" \
    uv run lightrag-server \
    > "$LOG_DIR/lightrag.log" 2>&1 &
echo $! > "$PID_DIR/lightrag.pid"
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
wait_port "$LIGHTRAG_PORT"         "LightRAG"         30 || true
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
echo -e "  ${CYAN}Knowledge Base:${NC}  http://localhost:$NGINX_PORT/kb/"
echo -e "  ${CYAN}AI PPT:${NC}          http://localhost:$NGINX_PORT/ppt/"
echo ""
echo -e "  ${CYAN}Direct access (debugging):${NC}"
echo -e "    Clawith frontend  http://localhost:$CLAWITH_FRONTEND_PORT"
echo -e "    Clawith backend   http://localhost:$CLAWITH_BACKEND_PORT/api/health"
echo -e "    LightRAG          http://localhost:$LIGHTRAG_PORT"
echo -e "    AIPPT             http://localhost:$AIPPT_PORT"
echo ""
echo -e "  Logs:   tail -f $LOG_DIR/*.log"
echo -e "  Stop:   ./stop.sh"
echo ""
