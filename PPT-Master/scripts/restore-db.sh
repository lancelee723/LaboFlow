#!/usr/bin/env bash
# restore-db.sh — Restore pptmaster PostgreSQL database from a compressed dump.
#
# Usage:
#   ./scripts/restore-db.sh /var/backups/pptmaster/pptmaster-20260101T020000Z.sql.gz
#
# Environment variables (optional):
#   COMPOSE_FILE  — path to the production compose file
#                   (default: /opt/pptmaster/production.docker-compose.yml)
#
# WARNING: This overwrites all data in the current database.
#          Stop the worker before restoring to avoid write conflicts:
#            docker compose -f production.docker-compose.yml stop worker
#          Then restore, then restart:
#            docker compose -f production.docker-compose.yml start worker

set -euo pipefail

BACKUP_FILE="${1:?Usage: restore-db.sh <backup.sql.gz>}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/pptmaster/production.docker-compose.yml}"
PGUSER="${PGUSER:-pptmaster}"
PGDATABASE="${PGDATABASE:-pptmaster}"

if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "ERROR: Backup file not found: $BACKUP_FILE" >&2
    exit 1
fi

echo "WARNING: This will overwrite all data in the pptmaster database."
echo "Backup file: $BACKUP_FILE"
echo "Compose file: $COMPOSE_FILE"
echo ""
echo "Press Ctrl-C to abort, or Enter to continue..."
read -r

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting restore from: $BACKUP_FILE"

gunzip -c "$BACKUP_FILE" | docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U "$PGUSER" "$PGDATABASE"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Restore complete."
