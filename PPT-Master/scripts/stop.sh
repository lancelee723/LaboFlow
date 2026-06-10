#!/usr/bin/env bash
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$REPO_ROOT/.dev/worker.pid" ]] && {
    kill "$(cat "$REPO_ROOT/.dev/worker.pid")" 2>/dev/null || true
    rm "$REPO_ROOT/.dev/worker.pid"
}
docker compose -f "$REPO_ROOT/scripts/dev-infra.docker-compose.yml" down
echo "Stopped"
