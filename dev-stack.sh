#!/usr/bin/env bash
# dev-stack.sh — 一键启动/体检 LaboFlow 本地全家桶
#   ./dev-stack.sh          启动 server(:8787) + console(:5180)（桌面端请另用 pnpm dev）
#   ./dev-stack.sh --check  体检：探活各服务 + 管理台登录链路
# 数据库: 本机 Postgres（postgresql@15，库名 laboflow_dev）
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DATABASE_URL='postgres://pptmaster:pptmaster_dev@127.0.0.1:5432/laboflow_dev'
export JWT_SECRET='laboflow-dev-secret-0123456789abcdef'
export PORT=8787
export LABOFLOW_API='http://127.0.0.1:8787'

alive() { lsof -ti:"$1" > /dev/null 2>&1; }

start_server() {
  alive 8787 && { echo "[server] 已在运行 :8787"; return; }
  (cd "$ROOT/apps/server" && nohup pnpm start > /tmp/laboflow-server.log 2>&1 &)
  sleep 5
  echo "[server] http://127.0.0.1:8787  $(curl -s -m 3 http://127.0.0.1:8787/healthz || echo '(启动中)')"
}

start_console() {
  alive 5180 && { echo "[console] 已在运行 :5180"; return; }
  (cd "$ROOT/apps/admin-console" && LABOFLOW_API="$LABOFLOW_API" nohup pnpm dev --port 5180 --strictPort > /tmp/laboflow-console.log 2>&1 &)
  sleep 4
  echo "[console] http://localhost:5180  (代理 → $LABOFLOW_API)"
}

check() {
  echo "== 体检 =="
  curl -s -m 3 http://127.0.0.1:8787/healthz > /dev/null 2>&1 \
    && echo "server  :8787  OK" || echo "server  :8787  DOWN  → ./dev-stack.sh"
  curl -s -m 3 -o /dev/null http://localhost:5180/ 2>/dev/null \
    && echo "console :5180  OK" || echo "console :5180  DOWN  → ./dev-stack.sh"
  # 管理台登录链路（经 console 代理）
  code=$(curl -s -m 5 -o /dev/null -w "%{http_code}" -X POST \
    http://localhost:5180/api/auth/login \
    -H 'content-type: application/json' \
    -d '{"username":"__probe__","password":"__probe__"}' 2>/dev/null)
  case "$code" in
    401) echo "login   :5180  OK (401 = 服务在,密码错属正常)";;
    000) echo "login   :5180  DOWN";;
    *)   echo "login   :5180  HTTP $code";;
  esac
  curl -s -m 3 -o /dev/null http://localhost:5173 2>/dev/null \
    && echo "desktop :5173  OK" || echo "desktop :5173  未启动 (apps/desktop: pnpm dev)"
}

case "${1:-}" in
  --check) check ;;
  --server-only) start_server ;;
  *) start_server; start_console; check ;;
esac
