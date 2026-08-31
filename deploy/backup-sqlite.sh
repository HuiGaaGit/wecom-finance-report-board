#!/usr/bin/env bash
set -euo pipefail

case "${DB_FILE:-}" in
  /var/lib/wecom-finance/*) ;;
  *) echo "DB_FILE 必须位于 /var/lib/wecom-finance/" >&2; exit 1 ;;
esac

backup_dir=/var/lib/wecom-finance/backups
mkdir -p "$backup_dir"
timestamp=$(date +%Y%m%d-%H%M%S)
destination="$backup_dir/report-board-$timestamp.db"
sqlite3 "$DB_FILE" ".timeout 10000" ".backup '$destination'"
chmod 0640 "$destination"
find "$backup_dir" -maxdepth 1 -type f -name 'report-board-*.db' -mtime +14 -delete
echo "SQLite backup created: $destination"
