#!/usr/bin/env bash
# backup-db.sh — Dump the pptmaster PostgreSQL database to a compressed file.
#
# Usage:
#   ./scripts/backup-db.sh
#
# Environment variables (all optional, defaults shown):
#   BACKUP_DIR    — where to write .sql.gz files  (default: /var/backups/pptmaster)
#   COMPOSE_FILE  — path to the production compose file
#                   (default: /opt/pptmaster/production.docker-compose.yml)
#
# Cron example (daily at 02:00):
#   0 2 * * * COMPOSE_FILE=/opt/pptmaster/production.docker-compose.yml \
#             /opt/pptmaster/scripts/backup-db.sh >> /var/log/pptmaster-backup.log 2>&1

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/pptmaster}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/pptmaster/production.docker-compose.yml}"
PGUSER="${PGUSER:-pptmaster}"
PGDATABASE="${PGDATABASE:-pptmaster}"

mkdir -p "$BACKUP_DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
DEST="$BACKUP_DIR/pptmaster-$TS.sql.gz"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting backup..."

docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump -U "$PGUSER" "$PGDATABASE" \
    | gzip > "$DEST"

# Keep only the 30 most recent backups
ls -1t "$BACKUP_DIR"/pptmaster-*.sql.gz 2>/dev/null | tail -n +31 | xargs -r rm --

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Backup saved: $DEST"
