#!/usr/bin/env bash
# dev.sh - Start local dev stack
# Usage: ./scripts/dev.sh         (foreground, Ctrl+C stops all)
#        ./scripts/dev.sh --bg   (background, use ./scripts/stop.sh to stop)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Step 1: Check prerequisites
need() { command -v "$1" >/dev/null || { echo "Missing: $1"; exit 1; }; }
need python3 && need node && need npm && need docker

PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
[[ $(awk "BEGIN{print ($PY_VER >= 3.12)}") -eq 1 ]] || { echo "Need Python >= 3.12, got $PY_VER"; exit 1; }

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
[[ $NODE_VER -ge 22 ]] || { echo "Need Node >= 22, got $NODE_VER"; exit 1; }

# Step 2: Prepare .env.local
if [[ ! -f .env.local ]]; then
    cp .env.local.example .env.local
    echo "Created .env.local from template"
fi
set -a; source .env.local; set +a

# Step 3: Start infrastructure
echo "Starting Postgres + Gotenberg ..."
docker compose -f scripts/dev-infra.docker-compose.yml up -d
until docker compose -f scripts/dev-infra.docker-compose.yml exec -T postgres pg_isready -U pptmaster >/dev/null 2>&1; do
    sleep 1
done
echo "Infrastructure ready"

# Step 4: Python environment
cd "$REPO_ROOT/apps/worker"
[[ -d .venv ]] || python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]" --quiet

# Step 5: DB migration + bootstrap
alembic upgrade head
python -m pptmaster.bootstrap

# Step 6: worker (foreground or background)
cd "$REPO_ROOT/apps/worker"
WORKER_LOG="$REPO_ROOT/.dev/worker.log"
mkdir -p "$REPO_ROOT/.dev"

if [[ "${1:-}" == "--bg" ]]; then
    nohup uvicorn pptmaster.main:app --reload --host 127.0.0.1 --port 5991 \
        > "$WORKER_LOG" 2>&1 &
    echo $! > "$REPO_ROOT/.dev/worker.pid"
    echo "Worker running in background, log: $WORKER_LOG"
else
    if [[ "$OSTYPE" == "darwin"* ]]; then
        osascript -e "tell app \"Terminal\" to do script \"cd $REPO_ROOT/apps/worker && source .venv/bin/activate && uvicorn pptmaster.main:app --reload --host 127.0.0.1 --port 5991\""
    else
        gnome-terminal -- bash -c "cd $REPO_ROOT/apps/worker && source .venv/bin/activate && uvicorn pptmaster.main:app --reload --host 127.0.0.1 --port 5991; exec bash" 2>/dev/null \
        || x-terminal-emulator -e "bash -c 'cd $REPO_ROOT/apps/worker && source .venv/bin/activate && uvicorn pptmaster.main:app --reload --host 127.0.0.1 --port 5991; exec bash'"
    fi
fi

# Step 7: Vite
cd "$REPO_ROOT/apps/webui"
[[ -d node_modules ]] || npm install

echo ""
echo "================================================"
echo "  Local services ready"
echo "  Frontend: http://localhost:5990"
echo "  Backend:  http://localhost:5991"
echo "  PG:       localhost:5992 (db=pptmaster user=pptmaster)"
echo "  Gotenberg: http://localhost:5993"
echo "  Initial admin: ${INITIAL_ADMIN_EMAIL} / ${INITIAL_ADMIN_PASSWORD:-123456}"
echo "================================================"
echo ""

npm run dev
