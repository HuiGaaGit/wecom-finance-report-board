#!/usr/bin/env bash
set -euo pipefail

backup_root=${BACKUP_ROOT:-/var/backups/wecom-finance-report-board}
retention_days=${RETENTION_DAYS:-90}

resolved_root=$(readlink -f -- "$backup_root")
if [[ "$resolved_root" != "/var/backups/wecom-finance-report-board" ]]; then
  echo "备份根目录不符合项目 17 约定：$resolved_root" >&2
  exit 1
fi
if [[ ! "$retention_days" =~ ^[0-9]+$ ]] || (( retention_days < 30 )); then
  echo "保留天数必须是不小于 30 的整数" >&2
  exit 1
fi

find "$resolved_root/database" -maxdepth 1 -type f -name 'report-board-*.db' -mtime "+$retention_days" -delete
find "$resolved_root/manifests" -maxdepth 1 -type f \( -name '*.sha256' -o -name '*.meta' \) -mtime "+$retention_days" -delete
find "$resolved_root/config" -mindepth 1 -maxdepth 1 -type d -mtime "+$retention_days" -exec rm -rf -- {} +
echo "异机备份保留策略完成：数据库与配置保留 $retention_days 天，uploads 不自动删除"
