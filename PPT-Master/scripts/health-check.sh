#!/usr/bin/env bash
# health-check.sh — Verify the production stack is healthy.
#
# Usage:
#   ./scripts/health-check.sh
#
# Environment variables (optional):
#   PUBLIC_BASE_URL — full HTTPS URL of the deployment
#                     (default: https://localhost)
#   COMPOSE_FILE    — path to the production compose file
#                     (default: /opt/pptmaster/production.docker-compose.yml)
#
# Exit code: 0 if all checks pass, 1 if any check fails.

set -euo pipefail

BASE_URL="${PUBLIC_BASE_URL:-https://localhost}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/pptmaster/production.docker-compose.yml}"

status=0

# Check HTTP reachability via the worker /health endpoint
if curl -fsSk "$BASE_URL/api/health" > /dev/null 2>&1; then
    echo "OK  worker API reachable ($BASE_URL/api/health)"
else
    echo "FAIL  worker API not reachable ($BASE_URL/api/health)" >&2
    status=1
fi

# Check webui root is reachable
if curl -fsSk "$BASE_URL/" > /dev/null 2>&1; then
    echo "OK  webui reachable ($BASE_URL/)"
else
    echo "FAIL  webui not reachable ($BASE_URL/)" >&2
    status=1
fi

# Check all containers are in running state
if docker compose -f "$COMPOSE_FILE" ps --format json 2>/dev/null \
        | grep -q '"State":"running"'; then
    echo "OK  at least one container is running"
else
    echo "FAIL  no containers in running state" >&2
    docker compose -f "$COMPOSE_FILE" ps 2>/dev/null || true
    status=1
fi

exit "$status"
