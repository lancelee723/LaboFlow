#!/usr/bin/env bash
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker compose -f "$REPO_ROOT/scripts/dev-infra.docker-compose.yml" down -v
rm -rf "$REPO_ROOT/.dev/data"
echo "DB + local data cleared"
