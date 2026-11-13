#!/bin/sh
# Daily SQLite backup for memoryd, keeping the last 14 copies.
#
#   MEMORYD_DB=~/dsh-memory/data/memory.db
#   MEMORYD_BACKUP_DIR=~/dsh-memory-backups
#
# `sqlite3 .backup` is safe while the service runs: it copies a consistent
# snapshot instead of touching the live file, which matters because writes can
# arrive at any time (DSH sessions are not scheduled).
set -eu

DB="${MEMORYD_DB:-$HOME/dsh-memory/data/memory.db}"
DEST="${MEMORYD_BACKUP_DIR:-$HOME/dsh-memory-backups}"
KEEP="${MEMORYD_BACKUP_KEEP:-14}"

if [ ! -f "$DB" ]; then
  echo "backup: database not found: $DB" >&2
  exit 1
fi

mkdir -p "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$DEST/memory-$STAMP.db"

sqlite3 "$DB" ".backup '$TARGET'"

COUNT="$(ls -1 "$DEST"/memory-*.db 2>/dev/null | wc -l | tr -d ' ')"
if [ "$COUNT" -gt "$KEEP" ]; then
  ls -1t "$DEST"/memory-*.db | tail -n "+$((KEEP + 1))" | while IFS= read -r OLD; do
    rm -f "$OLD"
  done
fi

echo "backup: $TARGET (keeping $KEEP)"
