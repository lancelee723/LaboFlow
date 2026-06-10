#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Labo-Flow — Dev mode orchestrator
#
# Starts all services with hot-reload:
#   1. Clawith backend   (uvicorn --reload on :8008)
#   2. Clawith frontend  (vite on :3080)
#   3. WeKnora infra     (docker compose dev on postgres/redis/docreader)
#      WeKnora backend   (go run on :8080)
#      WeKnora frontend  (vite on :8800, base=/kb/)
#   4. Pro Slides daemon (Express on :7456, serves backend + static frontend)
#   5. NGINX             (unified entry on :3008)
#
# WeKnora uses its native local-dev workflow:
#   - Infrastructure (postgres/redis/docreader) runs in Docker
#   - Go backend and Vue frontend run directly on the host
#   - Backend supports Air hot-reload if installed
#   - Frontend supports Vite HMR (hot module replacement)
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
if [ "${1:-}" = "--test" ]; then
    shift
    BACKEND_DIR="$ROOT/Clawith/backend"
    VENV="$BACKEND_DIR/.venv-test"

    echo -e "\033[0;36m[dev.sh --test]\033[0m Setting up test environment..."

    if [ ! -x "$VENV/bin/python" ]; then
        echo "  Creating .venv-test with Python 3.12 (via uv)..."
        uv venv --python 3.12 "$VENV"
    fi

    uv pip install --python "$VENV/bin/python" -e "$BACKEND_DIR[dev]" --quiet

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
: "${WEKNORA_FRONTEND_PORT:=8800}"
: "${WEKNORA_APP_PORT:=8080}"
: "${PRO_SLIDES_PORT:=7456}"
: "${PPTMASTER_WEBUI_PORT:=5990}"
: "${PPTMASTER_WORKER_PORT:=5991}"
: "${PPTMASTER_POSTGRES_PORT:=5992}"
: "${PPTMASTER_CONVERTER_PORT:=5993}"
: "${PPTMASTER_POSTGRES_USER:=pptmaster}"
: "${PPTMASTER_POSTGRES_PASSWORD:=pptmaster_dev}"
: "${PPTMASTER_POSTGRES_DB:=pptmaster}"
: "${PPTMASTER_SSO_AUDIENCE:=ppt-master}"

PRO_SLIDES_DIR="$ROOT/Pro Slides"
PRO_SLIDES_ENABLED=false
# LandPPT (Python/FastAPI). Earlier dev.sh assumed a pnpm/Next.js project — the
# directory was repurposed for LandPPT; check for run.py + pyproject.toml.
if [ -f "$PRO_SLIDES_DIR/run.py" ] && [ -f "$PRO_SLIDES_DIR/pyproject.toml" ]; then
    PRO_SLIDES_ENABLED=true
fi

PPT_MASTER_DIR="$ROOT/PPT-Master"
PPT_MASTER_ENABLED=false
if [ -f "$PPT_MASTER_DIR/apps/worker/pyproject.toml" ]; then
    PPT_MASTER_ENABLED=true
fi

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

detect_compose() {
    if docker compose version &>/dev/null; then
        echo "docker compose"
    elif command -v docker-compose &>/dev/null; then
        echo "docker-compose"
    else
        echo ""
    fi
}

# ── Pre-flight cleanup ───────────────────────────────────────
log "Cleaning up any previous processes..."
for pidfile in "$PID_DIR"/*.pid; do
    [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
done
for port in $NGINX_PORT $CLAWITH_FRONTEND_PORT $CLAWITH_BACKEND_PORT $WEKNORA_FRONTEND_PORT $WEKNORA_APP_PORT $PRO_SLIDES_PORT $PPTMASTER_WEBUI_PORT $PPTMASTER_WORKER_PORT; do
    cleanup_port "$port"
done

# Pre-flight: clean up previous PPT-Master docker containers (if any)
if [ "$PPT_MASTER_ENABLED" = true ]; then
    docker rm -f laboflow-pptmaster-postgres laboflow-pptmaster-converter 2>/dev/null || true
fi
sleep 1

COMPOSE=$(detect_compose)
if [ -z "$COMPOSE" ]; then
    err "Docker Compose not found. Install Docker Desktop or docker-compose."
    exit 1
fi

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
    REDIS_URL="$REDIS_URL" \
    PUBLIC_BASE_URL="$PUBLIC_BASE_URL" \
    WEKNORA_URL="${WEKNORA_URL:-/kb}" \
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

# ── 3. WeKnora (local dev mode) ───────────────────────────────
log "Starting WeKnora infrastructure (postgres / redis / docreader) ..."
WEKNORA_DIR="$ROOT/WeKnora"

# Ensure WeKnora .env exists
if [ ! -f "$WEKNORA_DIR/.env" ]; then
    cp "$WEKNORA_DIR/.env.example" "$WEKNORA_DIR/.env"
    ok "Created WeKnora/.env from .env.example"
fi

# Start infrastructure containers (postgres-dev, redis-dev, docreader-dev)
$COMPOSE -f "$WEKNORA_DIR/docker-compose.dev.yml" -f "$ROOT/docker-compose.dev-override.yml" up -d \
    > "$LOG_DIR/weknora-infra.log" 2>&1 \
    || { err "WeKnora infra failed. Check $LOG_DIR/weknora-infra.log"; exit 1; }

# Wait for docreader gRPC (port 50051) — required by backend
log "Waiting for WeKnora DocReader on :50051 ..."
for i in $(seq 1 60); do
    if (command -v lsof &>/dev/null && lsof -iTCP:50051 -sTCP:LISTEN >/dev/null 2>&1) \
       || (command -v nc &>/dev/null && nc -z 127.0.0.1 50051 2>/dev/null); then
        ok "DocReader ready on :50051 (${i}s)"
        break
    fi
    sleep 1
done

# Start WeKnora Go backend (local, port 8080)
log "Starting WeKnora Go backend on :$WEKNORA_APP_PORT ..."
if ! command -v go &>/dev/null; then
    err "Go not found. Install: brew install go  (macOS)  or  apt install golang"
    err "Individual services are still running. Kill them with ./stop.sh"
    exit 1
fi

# Load WeKnora .env and override with localhost addresses
cd "$WEKNORA_DIR"
set -a
source .env
set +a

export GOPROXY=https://goproxy.cn,direct
export CGO_CFLAGS="-Wno-deprecated-declarations -Wno-gnu-folding-constant"
if [[ "$(uname)" == "Darwin" ]]; then
    export CGO_LDFLAGS="-Wl,-no_warn_duplicate_libraries"
fi

# Build WeKnora backend binary (go run has CGO issues on Go 1.26 + macOS)
WEKNORA_PID_FILE="$PID_DIR/weknora-app.pid"
WEKNORA_BIN="$DATA_DIR/weknora-server"
LDFLAGS="$("$WEKNORA_DIR/scripts/get_version.sh" ldflags 2>/dev/null || echo "")"
LDFLAGS="$LDFLAGS -X 'google.golang.org/protobuf/reflect/protoregistry.conflictPolicy=warn'"

if command -v air &>/dev/null; then
    log "Air detected — WeKnora backend will auto-reload on code changes"
    export CLAWITH_SSO_SECRET="${JWT_SECRET_KEY:-}"; export WEKNORA_TENANT_ENABLE_RBAC=false; nohup air > "$LOG_DIR/weknora-app.log" 2>&1 &
else
    log "Building WeKnora backend (go build)..."
    go build -ldflags="$LDFLAGS" -o "$WEKNORA_BIN" ./cmd/server \
        >> "$LOG_DIR/weknora-app.log" 2>&1 \
        || { err "WeKnora build failed. Check $LOG_DIR/weknora-app.log"; exit 1; }
    ok "WeKnora backend built"
    log "Starting WeKnora Go backend on :$WEKNORA_APP_PORT ..."
    # Read env values safely (avoids bash special-char issues with source .env)
    WK_DB_PASSWORD=$(grep -E '^DB_PASSWORD=' "$WEKNORA_DIR/.env" 2>/dev/null | cut -d= -f2-)
    WK_DB_USER=$(grep -E '^DB_USER=' "$WEKNORA_DIR/.env" 2>/dev/null | cut -d= -f2-)
    WK_DB_NAME=$(grep -E '^DB_NAME=' "$WEKNORA_DIR/.env" 2>/dev/null | cut -d= -f2-)
    WK_REDIS_PASSWORD=$(grep -E '^REDIS_PASSWORD=' "$WEKNORA_DIR/.env" 2>/dev/null | cut -d= -f2-)
    WK_JWT_SECRET=$(grep -E '^JWT_SECRET=' "$WEKNORA_DIR/.env" 2>/dev/null | cut -d= -f2-)
    WK_TENANT_AES_KEY=$(grep -E '^TENANT_AES_KEY=' "$WEKNORA_DIR/.env" 2>/dev/null | cut -d= -f2-)
    WK_SYSTEM_AES_KEY=$(grep -E '^SYSTEM_AES_KEY=' "$WEKNORA_DIR/.env" 2>/dev/null | cut -d= -f2-)

    nohup env \
        DB_DRIVER=postgres \
        DB_HOST=localhost \
        DB_PORT=5433 \
        DB_USER="${WK_DB_USER:-postgres}" \
        DB_PASSWORD="${WK_DB_PASSWORD:-}" \
        DB_NAME="${WK_DB_NAME:-WeKnora}" \
        REDIS_ADDR=localhost:6379 \
        REDIS_PASSWORD="${WK_REDIS_PASSWORD:-}" \
        DOCREADER_ADDR=localhost:50051 \
        DOCREADER_TRANSPORT=grpc \
        RETRIEVE_DRIVER=postgres \
        STORAGE_TYPE=local \
        STREAM_MANAGER_TYPE=redis \
        JWT_SECRET="${WK_JWT_SECRET:-}" \
        CLAWITH_SSO_SECRET="${JWT_SECRET_KEY:-}" \
        WEKNORA_TENANT_ENABLE_RBAC=false \
        GIN_MODE=release \
        WEKNORA_LANGUAGE=zh-CN \
        OTEL_EXPORTER_OTLP_ENDPOINT=localhost:4317 \
        TZ=Asia/Shanghai \
        LOCAL_STORAGE_BASE_DIR="$DATA_DIR/weknora-files" \
        AUTO_RECOVER_DIRTY=true \
        TENANT_AES_KEY="${WK_TENANT_AES_KEY:-}" \
        SYSTEM_AES_KEY="${WK_SYSTEM_AES_KEY:-}" \
        CONCURRENCY_POOL_SIZE=5 \
        ENABLE_GRAPH_RAG=false \
        DISABLE_REGISTRATION=false \
        SSRF_WHITELIST="${WK_SSRF_WHITELIST:-cdn-mineru.openxlab.org.cn,*.openxlab.org.cn,mineru.net}" \
        "$WEKNORA_BIN" \
        > "$LOG_DIR/weknora-app.log" 2>&1 &
fi
echo $! > "$WEKNORA_PID_FILE"
cd "$ROOT"

# Start WeKnora Vue frontend (local, port 8800, base=/kb/)
log "Starting WeKnora frontend on :$WEKNORA_FRONTEND_PORT (base=/kb/) ..."
cd "$WEKNORA_DIR/frontend"
if [ ! -d "node_modules" ]; then
    log "Installing WeKnora frontend dependencies..."
    npm install --silent > "$LOG_DIR/weknora-frontend-install.log" 2>&1 \
        || { err "npm install failed. Check $LOG_DIR/weknora-frontend-install.log"; exit 1; }
fi
nohup env VITE_BASE_URL=/kb/ \
    node_modules/.bin/vite --host 0.0.0.0 --port "$WEKNORA_FRONTEND_PORT" \
    > "$LOG_DIR/weknora-frontend.log" 2>&1 &
echo $! > "$PID_DIR/weknora-frontend.pid"
cd "$ROOT"

# ── 4. Pro Slides (LandPPT — Python/FastAPI) ─────────────────────
# LandPPT entrypoint is `python run.py`; HOST/PORT env vars control binding.
# Docker compose maps to 7456; we mirror that for nginx upstream consistency.
if [ "$PRO_SLIDES_ENABLED" = true ]; then
    cd "$PRO_SLIDES_DIR"
    if [ ! -d ".venv" ]; then
        log "Creating Pro Slides (LandPPT) venv via uv..."
        uv sync --no-dev >> "$LOG_DIR/pro-slides.log" 2>&1 \
            || { err "uv sync failed. Check $LOG_DIR/pro-slides.log"; exit 1; }
    fi
    log "Starting Pro Slides (LandPPT) on :$PRO_SLIDES_PORT ..."
    nohup env \
        HOST=0.0.0.0 \
        PORT="$PRO_SLIDES_PORT" \
        JWT_SECRET_KEY="$JWT_SECRET_KEY" \
        PPT_AGENT_ID="${PPT_AGENT_ID:-}" \
        NEXT_PUBLIC_PPT_AGENT_ID="${PPT_AGENT_ID:-}" \
        uv run python run.py \
        > "$LOG_DIR/pro-slides.log" 2>&1 &
    sleep 1
    pgrep -f "python run.py" > "$PID_DIR/pro-slides.pid" || true
    cd "$ROOT"
else
    log "Skipping Pro Slides startup: run.py / pyproject.toml not present in '$PRO_SLIDES_DIR'."
fi

# ── 5. PPT-Master (optional) ─────────────────────────────────
# Docker runs OS-level deps (postgres + gotenberg). Worker/webui run locally
# so code edits hot-reload without docker rebuilds.
if [ "$PPT_MASTER_ENABLED" = true ]; then
    # Reuse any existing container already listening on $PPTMASTER_POSTGRES_PORT.
    # Standalone PPT-Master dev setups often leave `pptmaster-dev-postgres` running;
    # we don't want to fight that.
    PPTMASTER_PG_CONTAINER=$(docker ps --filter "publish=$PPTMASTER_POSTGRES_PORT" --format '{{.Names}}' | head -1)
    if [ -n "$PPTMASTER_PG_CONTAINER" ]; then
        ok "Reusing existing PPT-Master postgres: $PPTMASTER_PG_CONTAINER on :$PPTMASTER_POSTGRES_PORT"
    else
        log "Starting PPT-Master postgres on :$PPTMASTER_POSTGRES_PORT (docker) ..."
        docker run -d --name laboflow-pptmaster-postgres \
            -p "$PPTMASTER_POSTGRES_PORT:5432" \
            -e POSTGRES_USER="$PPTMASTER_POSTGRES_USER" \
            -e POSTGRES_PASSWORD="$PPTMASTER_POSTGRES_PASSWORD" \
            -e POSTGRES_DB="$PPTMASTER_POSTGRES_DB" \
            postgres:16-alpine >> "$LOG_DIR/pptmaster-postgres.log" 2>&1 \
            || { err "pptmaster-postgres failed to start. Check $LOG_DIR/pptmaster-postgres.log"; exit 1; }
        PPTMASTER_PG_CONTAINER=laboflow-pptmaster-postgres
    fi

    # Converter (gotenberg): start only if a container already exists or the image
    # is locally cached. Don't pull from a remote registry in dev mode — if the
    # image isn't present, skip silently and PPTX export will be unavailable
    # until the user manually `docker pull gotenberg/gotenberg:8`.
    PPTMASTER_CV_CONTAINER=$(docker ps --filter "publish=$PPTMASTER_CONVERTER_PORT" --format '{{.Names}}' | head -1)
    PPTMASTER_CONVERTER_AVAILABLE=false
    if [ -n "$PPTMASTER_CV_CONTAINER" ]; then
        ok "Reusing existing PPT-Master converter: $PPTMASTER_CV_CONTAINER on :$PPTMASTER_CONVERTER_PORT"
        PPTMASTER_CONVERTER_AVAILABLE=true
    elif [ -n "$(docker images -q gotenberg/gotenberg:8 2>/dev/null)" ]; then
        log "Starting PPT-Master converter (gotenberg, image cached) on :$PPTMASTER_CONVERTER_PORT ..."
        docker run -d --name laboflow-pptmaster-converter \
            -p "$PPTMASTER_CONVERTER_PORT:3000" \
            gotenberg/gotenberg:8 \
            gotenberg --api-port=3000 --api-timeout=300s --libreoffice-restart-after=10 \
            >> "$LOG_DIR/pptmaster-converter.log" 2>&1 \
            || { err "pptmaster-converter failed to start. Check $LOG_DIR/pptmaster-converter.log"; exit 1; }
        PPTMASTER_CV_CONTAINER=laboflow-pptmaster-converter
        PPTMASTER_CONVERTER_AVAILABLE=true
    else
        log "PPT-Master converter image (gotenberg/gotenberg:8) not cached locally — skipping."
        log "  PPTX export will be unavailable. To enable: docker pull gotenberg/gotenberg:8"
    fi

    # Wait for postgres to accept connections
    log "Waiting for PPT-Master postgres..."
    for i in $(seq 1 30); do
        if docker exec "$PPTMASTER_PG_CONTAINER" pg_isready -U "$PPTMASTER_POSTGRES_USER" >/dev/null 2>&1; then
            ok "PPT-Master postgres ready (${i}s)"
            break
        fi
        sleep 1
    done

    # Ensure worker .venv
    WORKER_DIR="$PPT_MASTER_DIR/apps/worker"
    if [ ! -d "$WORKER_DIR/.venv" ]; then
        log "Creating PPT-Master worker venv via uv..."
        (cd "$WORKER_DIR" && uv sync --no-dev >> "$LOG_DIR/pptmaster-worker.log" 2>&1) \
            || { err "uv sync failed. Check $LOG_DIR/pptmaster-worker.log"; exit 1; }
    fi

    # One-shot DB migrate + bootstrap
    log "Migrating PPT-Master DB + bootstrapping admin..."
    PPT_MASTER_DB_URL="postgresql+asyncpg://$PPTMASTER_POSTGRES_USER:$PPTMASTER_POSTGRES_PASSWORD@localhost:$PPTMASTER_POSTGRES_PORT/$PPTMASTER_POSTGRES_DB"
    (cd "$WORKER_DIR" && \
        DATABASE_URL="$PPT_MASTER_DB_URL" \
        JWT_SECRET_KEY="$JWT_SECRET_KEY" \
        SYSTEM_AES_KEY="${SYSTEM_AES_KEY:-dev-32-bytes-aes-key-for-local-dev!}" \
        INITIAL_ADMIN_EMAIL="${PPTMASTER_INITIAL_ADMIN_EMAIL:-admin@local.dev}" \
        INITIAL_ADMIN_PASSWORD="${PPTMASTER_INITIAL_ADMIN_PASSWORD:-change-me-strong}" \
        DEPLOYMENT_MODE=standalone \
        uv run alembic upgrade head >> "$LOG_DIR/pptmaster-worker.log" 2>&1) \
        || { err "alembic upgrade failed. Check $LOG_DIR/pptmaster-worker.log"; exit 1; }
    (cd "$WORKER_DIR" && \
        DATABASE_URL="$PPT_MASTER_DB_URL" \
        JWT_SECRET_KEY="$JWT_SECRET_KEY" \
        SYSTEM_AES_KEY="${SYSTEM_AES_KEY:-dev-32-bytes-aes-key-for-local-dev!}" \
        INITIAL_ADMIN_EMAIL="${PPTMASTER_INITIAL_ADMIN_EMAIL:-admin@local.dev}" \
        INITIAL_ADMIN_PASSWORD="${PPTMASTER_INITIAL_ADMIN_PASSWORD:-change-me-strong}" \
        DEPLOYMENT_MODE=standalone \
        uv run python -m pptmaster.bootstrap >> "$LOG_DIR/pptmaster-worker.log" 2>&1) \
        || true  # bootstrap is idempotent — skip if already done

    # Start worker (FastAPI uvicorn)
    # Only inject PPTMASTER_CONVERTER_URL when a converter container actually
    # exists; otherwise the worker would block trying to reach a dead address.
    if [ "$PPTMASTER_CONVERTER_AVAILABLE" = true ]; then
        PPTMASTER_CONVERTER_URL_ENV="http://localhost:$PPTMASTER_CONVERTER_PORT"
    else
        PPTMASTER_CONVERTER_URL_ENV=""
    fi
    log "Starting PPT-Master worker on :$PPTMASTER_WORKER_PORT ..."
    (cd "$WORKER_DIR" && \
        nohup env \
            DATABASE_URL="$PPT_MASTER_DB_URL" \
            JWT_SECRET_KEY="$JWT_SECRET_KEY" \
            JWT_ALGORITHM=HS256 \
            SYSTEM_AES_KEY="${SYSTEM_AES_KEY:-dev-32-bytes-aes-key-for-local-dev!}" \
            PPTMASTER_SSO_AUDIENCE="$PPTMASTER_SSO_AUDIENCE" \
            PPTMASTER_CONVERTER_URL="$PPTMASTER_CONVERTER_URL_ENV" \
            PUBLIC_BASE_URL="http://localhost:$NGINX_PORT/ppt-master" \
            STORAGE_BACKEND=volume \
            STORAGE_ROOT="$DATA_DIR/pptmaster" \
            PPTMASTER_SCRIPTS_DIR="$PPT_MASTER_DIR/skills/ppt-master/scripts" \
            PPTMASTER_TEMPLATES_DIR="$PPT_MASTER_DIR/skills/ppt-master/templates" \
            PPTMASTER_SKILL_TEMPLATES_ROOT="$PPT_MASTER_DIR/skills/ppt-master/templates" \
            DEPLOYMENT_MODE=standalone \
            uv run uvicorn pptmaster.main:app --host 0.0.0.0 --port "$PPTMASTER_WORKER_PORT" \
            > "$LOG_DIR/pptmaster-worker.log" 2>&1 &)
    sleep 1
    pgrep -f "uvicorn pptmaster.main:app" > "$PID_DIR/pptmaster-worker.pid" || true

    # Start webui (Vite dev server)
    log "Starting PPT-Master webui on :$PPTMASTER_WEBUI_PORT ..."
    WEBUI_DIR="$PPT_MASTER_DIR/apps/webui"
    if [ ! -d "$WEBUI_DIR/node_modules" ]; then
        log "Installing PPT-Master webui deps..."
        (cd "$WEBUI_DIR" && npm install >> "$LOG_DIR/pptmaster-webui.log" 2>&1) \
            || { err "npm install failed. Check $LOG_DIR/pptmaster-webui.log"; exit 1; }
    fi
    (cd "$WEBUI_DIR" && \
        nohup npm run dev -- --host 0.0.0.0 --port "$PPTMASTER_WEBUI_PORT" \
        > "$LOG_DIR/pptmaster-webui.log" 2>&1 &)
    sleep 1
    pgrep -f "vite.*$PPTMASTER_WEBUI_PORT" > "$PID_DIR/pptmaster-webui.pid" || true
else
    log "Skipping PPT-Master startup: not present in '$PPT_MASTER_DIR'."
fi

# ── Wait for upstreams ───────────────────────────────────────
log "Waiting for upstream services..."
wait_port "$CLAWITH_BACKEND_PORT"  "Clawith backend"  30 || true
wait_port "$CLAWITH_FRONTEND_PORT" "Clawith frontend" 20 || true
wait_port "$WEKNORA_APP_PORT"      "WeKnora backend"  90 || true
wait_port "$WEKNORA_FRONTEND_PORT" "WeKnora frontend" 30 || true
if [ "$PRO_SLIDES_ENABLED" = true ]; then
    wait_port "$PRO_SLIDES_PORT" "Pro Slides" 20 || true
fi
if [ "$PPT_MASTER_ENABLED" = true ]; then
    wait_port "$PPTMASTER_WORKER_PORT" "PPT-Master worker" 30 || true
    wait_port "$PPTMASTER_WEBUI_PORT"  "PPT-Master webui"  20 || true
fi

# ── 6. NGINX ─────────────────────────────────────────────────
log "Starting NGINX on :$NGINX_PORT ..."
if ! command -v nginx &>/dev/null; then
    err "nginx not found. Install with: brew install nginx  (macOS)  or  apt install nginx  (Linux)"
    err "Individual services are still running. Kill them with ./stop.sh"
    exit 1
fi

cd "$ROOT"
nohup nginx -p "$ROOT" -c "$ROOT/nginx.conf" -g 'daemon off;' \
    > "$LOG_DIR/nginx.log" 2>&1 &
echo $! > "$PID_DIR/nginx.pid"
sleep 1
wait_port "$NGINX_PORT" "NGINX" 10 || true

# ── Summary ──────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Labo-Flow dev environment is up${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Unified entry:${NC}   http://localhost:$NGINX_PORT"
echo -e "  ${CYAN}Knowledge Base:${NC}  http://localhost:$NGINX_PORT/kb/"
if [ "$PRO_SLIDES_ENABLED" = true ]; then
    echo -e "  ${CYAN}AI PPT:${NC}          http://localhost:$NGINX_PORT/ppt/"
else
    echo -e "  ${CYAN}AI PPT:${NC}          disabled (Pro Slides app not present)"
fi
if [ "$PPT_MASTER_ENABLED" = true ]; then
    echo -e "  ${CYAN}PPT Master:${NC}      http://localhost:$NGINX_PORT/ppt-master/"
else
    echo -e "  ${CYAN}PPT Master:${NC}      disabled (PPT-Master app not present)"
fi
echo ""
echo -e "  ${CYAN}Direct access (debugging):${NC}"
echo -e "    Clawith frontend  http://localhost:$CLAWITH_FRONTEND_PORT"
echo -e "    Clawith backend   http://localhost:$CLAWITH_BACKEND_PORT/api/health"
echo -e "    WeKnora backend   http://localhost:$WEKNORA_APP_PORT"
echo -e "    WeKnora frontend  http://localhost:$WEKNORA_FRONTEND_PORT/kb/"
if [ "$PRO_SLIDES_ENABLED" = true ]; then
    echo -e "    Pro Slides        http://localhost:$PRO_SLIDES_PORT"
else
    echo -e "    Pro Slides        disabled"
fi
if [ "$PPT_MASTER_ENABLED" = true ]; then
    echo -e "    PPT-Master webui  http://localhost:$PPTMASTER_WEBUI_PORT"
    echo -e "    PPT-Master worker http://localhost:$PPTMASTER_WORKER_PORT/health"
fi
echo ""
echo -e "  Logs:   tail -f $LOG_DIR/*.log"
echo -e "  Stop:   ./stop.sh"
echo ""
