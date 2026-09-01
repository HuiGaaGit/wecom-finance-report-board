#!/usr/bin/env bash
set -euo pipefail

umask 077

for name in OFFSITE_HOST OFFSITE_USER OFFSITE_SSH_KEY OFFSITE_KNOWN_HOSTS; do
  if [[ -z "${!name:-}" ]]; then
    echo "缺少环境变量：$name" >&2
    exit 1
  fi
done

container_name=${CONTAINER_NAME:-wecom-finance-report-board}
data_root=${DATA_ROOT:-/data/data/wecom-finance-report-board}
compose_file=${COMPOSE_FILE:-/data/opt/wecom-finance-report-board/compose.yml}
nginx_file=${NGINX_FILE:-/etc/nginx/snippets/wecom-finance-report-board.conf}
environment_file=${PRODUCTION_ENV_FILE:-/data/secrets/wecom-finance-report-board/report-board.env}
lock_file=${OFFSITE_LOCK_FILE:-/run/lock/wecom-finance-offsite-backup.lock}

case "$data_root" in
  /data/data/wecom-finance-report-board) ;;
  *) echo "DATA_ROOT 不是项目 17 的生产数据目录：$data_root" >&2; exit 1 ;;
esac

for command_name in docker rsync ssh sha256sum flock install find; do
  command -v "$command_name" >/dev/null || { echo "缺少命令：$command_name" >&2; exit 1; }
done
for required_file in "$compose_file" "$nginx_file" "$environment_file" "$OFFSITE_SSH_KEY" "$OFFSITE_KNOWN_HOSTS"; do
  [[ -f "$required_file" ]] || { echo "缺少备份输入：$required_file" >&2; exit 1; }
done

exec 9>"$lock_file"
if ! flock -n 9; then
  echo "异机备份已有实例运行，本次跳过"
  exit 0
fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
stage_directory=$(mktemp -d /tmp/wecom-finance-offsite-backup.XXXXXX)
trap 'rm -rf -- "$stage_directory"' EXIT
mkdir -p "$stage_directory/config" "$stage_directory/manifests"

container_backup=$(docker exec "$container_name" node deploy/backup-database.mjs | tail -n 1)
backup_name=$(basename -- "$container_backup")
case "$backup_name" in
  report-board-*.db) ;;
  *) echo "数据库备份返回了异常文件名：$backup_name" >&2; exit 1 ;;
esac
database_backup="$data_root/backups/$backup_name"
[[ -s "$database_backup" ]] || { echo "一致性数据库备份不存在或为空：$database_backup" >&2; exit 1; }

install -m 0600 "$compose_file" "$stage_directory/config/compose.yml"
install -m 0600 "$nginx_file" "$stage_directory/config/nginx.conf"
install -m 0600 "$environment_file" "$stage_directory/config/report-board.env"

(
  cd "$data_root/backups"
  sha256sum "$backup_name"
  cd "$stage_directory/config"
  sha256sum compose.yml nginx.conf report-board.env
) >"$stage_directory/manifests/$timestamp.sha256"

upload_count=$(find "$data_root/uploads" -type f | wc -l)
upload_bytes=$(du -sb "$data_root/uploads" | awk '{print $1}')
printf 'timestamp=%s\ndatabase=%s\nupload_files=%s\nupload_bytes=%s\n' "$timestamp" "$backup_name" "$upload_count" "$upload_bytes" >"$stage_directory/manifests/$timestamp.meta"

rsync_ssh="ssh -i $OFFSITE_SSH_KEY -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$OFFSITE_KNOWN_HOSTS"
destination="$OFFSITE_USER@$OFFSITE_HOST"
rsync_options=(-a --partial --ignore-existing --no-owner --no-group --chmod=D700,F600 -e "$rsync_ssh")

rsync "${rsync_options[@]}" "$database_backup" "$destination:database/"
rsync "${rsync_options[@]}" "$data_root/uploads/" "$destination:uploads/"
rsync "${rsync_options[@]}" "$stage_directory/config/" "$destination:config/$timestamp/"
rsync "${rsync_options[@]}" "$stage_directory/manifests/" "$destination:manifests/"

status_file="$data_root/backups/offsite-last-success.meta"
printf 'timestamp=%s\ndatabase=%s\nupload_files=%s\nupload_bytes=%s\ndestination=%s\n' "$timestamp" "$backup_name" "$upload_count" "$upload_bytes" "$OFFSITE_HOST" >"$status_file"
chmod 0640 "$status_file"
echo "异机备份完成：$timestamp · $backup_name · $upload_count 个上传文件"
