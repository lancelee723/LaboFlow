#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Labo-Flow — First-time setup orchestrator
#
# Walks through each component's install steps so the user
# can run ./dev.sh afterwards. Idempotent.
#
# Steps:
#   1. Ensure top-level .env exists (copy from .env.example)
#   2. Clawith:  run its own setup.sh
#   3. WeKnora:  start Docker services
#   4. AIPPT:    pnpm install (skip if node_modules exists)
#   5. Sanity check: required tools present (nginx, uv, pnpm)
# ─────────────────────────────────────────────────────────────
set -e

# Ensure Homebrew paths are available (macOS non-interactive shells may miss them)
for _brew_prefix in /opt/homebrew /usr/local; do
    [ -d "$_brew_prefix/bin" ] && export PATH="$_brew_prefix/bin:$_brew_prefix/sbin:$PATH"
done

ROOT="$(cd "$(dirname "$0")" && pwd)"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'

step()  { echo -e "\n${CYAN}▸ $*${NC}"; }
ok()    { echo -e "  ${GREEN}✓${NC} $*"; }
warn()  { echo -e "  ${YELLOW}⚠${NC} $*"; }
fail()  { echo -e "  ${RED}✗${NC} $*"; exit 1; }

have()  { command -v "$1" &>/dev/null; }

echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo -e "${CYAN}  🦞 Labo-Flow — First-time Setup${NC}"
echo -e "${CYAN}═══════════════════════════════════════${NC}"

# ── 1. Top-level .env ────────────────────────────────────────
step "[1/5] Ensuring top-level .env"
if [ ! -f "$ROOT/.env" ]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    ok "Created .env from .env.example"
    warn "Edit .env to set JWT_SECRET_KEY and LLM API keys before first run."
else
    ok ".env already exists"
fi

# ── 2. Tool sanity check ─────────────────────────────────────
step "[2/5] Checking required tools"
MISSING=()
have nginx || MISSING+=("nginx  (brew install nginx / apt install nginx)")
have uv    || MISSING+=("uv     (curl -LsSf https://astral.sh/uv/install.sh | sh)")
have pnpm  || MISSING+=("pnpm   (npm install -g pnpm)")
have python3 || MISSING+=("python3 >= 3.12")

if [ "${#MISSING[@]}" -gt 0 ]; then
    for m in "${MISSING[@]}"; do warn "Missing: $m"; done
    fail "Install the tools above, then re-run this script."
else
    ok "nginx, uv, pnpm, python3 all present"
fi

# ── 3. Clawith ───────────────────────────────────────────────
step "[3/5] Clawith"

# Auto-detect Python 3.12+ for Clawith (macOS system python3 is often too old)
CLAWITH_PYTHON=""
for candidate in python3.13 python3.12 python3; do
    if have "$candidate"; then
        ver=$("$candidate" -c 'import sys; print(sys.version_info.minor)' 2>/dev/null)
        if [ "${ver:-0}" -ge 12 ]; then
            CLAWITH_PYTHON="$candidate"
            break
        fi
    fi
done
# Also check Homebrew paths on macOS
if [ -z "$CLAWITH_PYTHON" ]; then
    for bp in /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.13 /usr/local/bin/python3.12 /usr/local/bin/python3.13; do
        if [ -x "$bp" ]; then
            CLAWITH_PYTHON="$bp"
            break
        fi
    done
fi
if [ -z "$CLAWITH_PYTHON" ]; then
    fail "Python 3.12+ not found. Install with: brew install python@3.12"
fi

NEED_CLAWITH_SETUP=false
if [ ! -f "$ROOT/Clawith/backend/.venv/bin/python" ]; then
    NEED_CLAWITH_SETUP=true
fi
if [ ! -d "$ROOT/Clawith/frontend/node_modules" ]; then
    NEED_CLAWITH_SETUP=true
fi

if [ "$NEED_CLAWITH_SETUP" = true ]; then
    ok "Using Python: $CLAWITH_PYTHON ($($CLAWITH_PYTHON --version))"
    warn "Running Clawith/setup.sh — this installs Python deps, frontend deps, and sets up Postgres"
    ( cd "$ROOT/Clawith" && PYTHON_BIN="$CLAWITH_PYTHON" bash setup.sh ) || fail "Clawith setup failed"
    ok "Clawith setup complete"
else
    ok "Clawith backend .venv and frontend node_modules already set up (skipping)"
fi

# Install Playwright Chromium browser binary into the Clawith backend venv.
# pip installs the Python bindings (from pyproject.toml) but the browser
# binary must be downloaded separately via `playwright install`.
# Also ensure playwright Python package is installed (pre-existing venvs may
# have been created before playwright was added to pyproject.toml).
VENV_PIP="$ROOT/Clawith/backend/.venv/bin/pip"
PLAYWRIGHT_BIN="$ROOT/Clawith/backend/.venv/bin/playwright"
if [ -x "$VENV_PIP" ] && ! [ -x "$PLAYWRIGHT_BIN" ]; then
    warn "playwright not in .venv — installing Python bindings..."
    "$VENV_PIP" install "playwright>=1.47.0" "pypdf>=4.0.0" --quiet || fail "pip install playwright failed"
fi
if [ -x "$PLAYWRIGHT_BIN" ]; then
    # `playwright install` is idempotent — safe to re-run, fast when already installed
    warn "Installing Playwright Chromium browser binary (first time only, ~120 MB)..."
    "$PLAYWRIGHT_BIN" install chromium || fail "playwright install chromium failed"
    ok "Playwright Chromium ready"
else
    warn "playwright not found in .venv — skipping Chromium install"
    warn "To install manually:  Clawith/backend/.venv/bin/pip install playwright && Clawith/backend/.venv/bin/playwright install chromium"
fi

# ── 4. WeKnora ──────────────────────────────────────────────
step "[4/5] WeKnora — dev environment setup"

# Check Go (required for local backend)
if ! have go; then
    warn "Go not found — install with: brew install go (macOS) or apt install golang"
    warn "WeKnora backend will NOT start without Go. Skipping Go-dependent steps."
    GO_MISSING=true
else
    ok "Go $(go version | awk '{print $3}') available"
    GO_MISSING=false
fi

# Ensure WeKnora .env exists
if [ ! -f "$ROOT/WeKnora/.env" ]; then
    cp "$ROOT/WeKnora/.env.example" "$ROOT/WeKnora/.env"
    ok "Created WeKnora/.env from .env.example"
    warn "Edit WeKnora/.env to set JWT_SECRET (must match JWT_SECRET_KEY in .env)"
else
    ok "WeKnora/.env already exists"
fi

# Align JWT_SECRET for SSO
if [ -n "$JWT_SECRET_KEY" ] && [ "$JWT_SECRET_KEY" != "change-me-to-a-long-random-secret" ]; then
    current_weknora_jwt=$(grep "^JWT_SECRET=" "$ROOT/WeKnora/.env" 2>/dev/null | cut -d= -f2)
    if [ "$current_weknora_jwt" != "$JWT_SECRET_KEY" ]; then
        warn "WeKnora JWT_SECRET differs from JWT_SECRET_KEY — updating for SSO compatibility"
        sed -i.bak "s/^JWT_SECRET=.*/JWT_SECRET=${JWT_SECRET_KEY}/" "$ROOT/WeKnora/.env"
        rm -f "$ROOT/WeKnora/.env.bak"
    fi
fi

# Start WeKnora Docker infrastructure (postgres, redis, docreader)
# Only the dependency services run in Docker; backend + frontend run locally
WEKNORA_DEPS_READY=false
if command -v nc &>/dev/null && nc -z 127.0.0.1 5432 2>/dev/null && nc -z 127.0.0.1 50051 2>/dev/null; then
    WEKNORA_DEPS_READY=true
    ok "WeKnora Docker infrastructure already running (postgres:5432, docreader:50051)"
fi

if [ "$WEKNORA_DEPS_READY" = false ]; then
    warn "Starting WeKnora Docker infrastructure (postgres + redis + docreader) ..."
    docker compose -f "$ROOT/WeKnora/docker-compose.dev.yml" up -d 2>&1 | tail -5 \
        || { warn "docker compose up failed — start WeKnora infra manually"; }
else
    ok "WeKnora Docker infrastructure ready"
fi

# Install WeKnora frontend dependencies
if [ -f "$ROOT/WeKnora/frontend/package.json" ]; then
    if [ ! -d "$ROOT/WeKnora/frontend/node_modules" ]; then
        warn "Installing WeKnora frontend dependencies (npm install)..."
        (cd "$ROOT/WeKnora/frontend" && npm install --silent) \
            || warn "WeKnora frontend npm install failed — run manually"
    else
        ok "WeKnora frontend node_modules already exists"
    fi
fi

# ── 5. AIPPT ─────────────────────────────────────────────────
step "[5/5] AIPPT"
cd "$ROOT/aippt"
if [ ! -f ".env" ]; then
    cp .env.example .env
    ok "Created aippt/.env"
fi
if [ ! -d "node_modules" ]; then
    warn "Running 'pnpm install' — may take a few minutes"
    pnpm install || fail "pnpm install failed"
    ok "AIPPT deps installed"
else
    ok "AIPPT node_modules already exists"
fi
cd "$ROOT"

# ── Done ─────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  🎉 Setup complete${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo ""
echo "  Next steps:"
echo "    1. Edit .env and set JWT_SECRET_KEY (generate with:"
echo "       python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
echo "    2. Set your LLM API keys in .env"
echo "    3. Run:  ./dev.sh"
echo ""
