#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Labo-Flow — Stop all dev services
# ─────────────────────────────────────────────────────────────
set -e

# Ensure Homebrew paths are available (macOS non-interactive shells may miss them)
for _brew_prefix in /opt/homebrew /usr/local; do
    [ -d "$_brew_prefix/bin" ] && export PATH="$_brew_prefix/bin:$_brew_prefix/sbin:$PATH"
done

ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_DIR="$ROOT/.data/pid"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'

# Load env for port discovery
[ -f "$ROOT/.env" ] && { set -a; source "$ROOT/.env"; set +a; }
: "${NGINX_PORT:=3008}"
: "${CLAWITH_FRONTEND_PORT:=3080}"
: "${CLAWITH_BACKEND_PORT:=8008}"
: "${WEKNORA_FRONTEND_PORT:=8800}"
: "${WEKNORA_APP_PORT:=8080}"
: "${AIPPT_PORT:=5173}"
: "${PPTMASTER_WEBUI_PORT:=5990}"
: "${PPTMASTER_WORKER_PORT:=5991}"

detect_compose() {
    if docker compose version &>/dev/null; then
        echo "docker compose"
    elif command -v docker-compose &>/dev/null; then
        echo "docker-compose"
    else
        echo ""
    fi
}

echo -e "${YELLOW}Stopping Labo-Flow services...${NC}"

# Stop nginx first so no new requests hit upstreams
if [ -f "$PID_DIR/nginx.pid" ]; then
    nginx -p "$ROOT" -c "$ROOT/nginx.conf" -s quit 2>/dev/null || \
        kill -TERM "$(cat "$PID_DIR/nginx.pid")" 2>/dev/null || true
    rm -f "$PID_DIR/nginx.pid"
    echo -e "  ${GREEN}✓${NC} nginx stopped"
fi

# Stop all PID-tracked processes
for pidfile in "$PID_DIR"/*.pid; do
    [ -f "$pidfile" ] || continue
    name=$(basename "$pidfile" .pid)
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null || true
        sleep 0.5
        kill -9 "$pid" 2>/dev/null || true
        echo -e "  ${GREEN}✓${NC} $name stopped (pid $pid)"
    fi
    rm -f "$pidfile"
done

# Stop WeKnora Docker infrastructure (dev compose)
COMPOSE=$(detect_compose)
if [ -n "$COMPOSE" ]; then
    $COMPOSE -f "$ROOT/WeKnora/docker-compose.dev.yml" -f "$ROOT/docker-compose.dev-override.yml" down 2>/dev/null || true
    echo -e "  ${GREEN}✓${NC} WeKnora Docker infrastructure stopped"
fi

# Stop PPT-Master docker dependencies (postgres + converter)
for c in laboflow-pptmaster-postgres laboflow-pptmaster-converter; do
    if docker ps -a --format '{{.Names}}' | grep -q "^${c}$"; then
        docker rm -f "$c" >/dev/null 2>&1 && echo -e "  ${GREEN}✓${NC} $c removed"
    fi
done

# Final sweep by port — catches orphaned processes
for port in $NGINX_PORT $CLAWITH_FRONTEND_PORT $CLAWITH_BACKEND_PORT $WEKNORA_FRONTEND_PORT $WEKNORA_APP_PORT $AIPPT_PORT $PPTMASTER_WEBUI_PORT $PPTMASTER_WORKER_PORT; do
    if command -v lsof &>/dev/null; then
        pids=$(lsof -ti:$port 2>/dev/null || true)
        if [ -n "$pids" ]; then
            echo "$pids" | xargs kill -9 2>/dev/null || true
            echo -e "  ${GREEN}✓${NC} cleaned up stragglers on :$port"
        fi
    fi
done

echo -e "${GREEN}All services stopped.${NC}"
