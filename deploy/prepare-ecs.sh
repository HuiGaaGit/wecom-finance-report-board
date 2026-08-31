#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "请使用 root 执行" >&2; exit 1; fi
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if ! command -v node >/dev/null || [[ $(node -p "Number(process.versions.node.split('.')[0])") -lt 20 ]]; then
  echo "请先安装 Node.js 20 LTS 或更高版本" >&2; exit 1
fi

missing_commands=()
for command_name in nginx sqlite3 curl python3; do
  command -v "$command_name" >/dev/null 2>&1 || missing_commands+=("$command_name")
done
if [[ ${#missing_commands[@]} -gt 0 ]]; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y nginx sqlite3 curl python3
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nginx sqlite curl python3
  else
    echo "缺少运行组件：${missing_commands[*]}；且未找到 apt-get 或 dnf" >&2
    exit 1
  fi
fi
for command_name in nginx sqlite3 curl python3; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "安装后仍缺少运行组件：$command_name" >&2
    exit 1
  fi
done

if id nginx >/dev/null 2>&1; then
  nginx_group=$(id -gn nginx)
elif id www-data >/dev/null 2>&1; then
  nginx_group=$(id -gn www-data)
else
  echo "未找到 Nginx 运行账户" >&2
  exit 1
fi

id -u wecom-finance >/dev/null 2>&1 || useradd --system --home /var/lib/wecom-finance --shell /usr/sbin/nologin wecom-finance
install -d -o root -g root -m 0755 /opt/wecom-finance /opt/wecom-finance/releases
install -d -o wecom-finance -g wecom-finance -m 0750 /var/lib/wecom-finance /var/lib/wecom-finance/uploads /var/lib/wecom-finance/backups
install -d -o root -g wecom-finance -m 0750 /etc/wecom-finance
install -d -o root -g "$nginx_group" -m 0750 /var/www/wecom-verification
install -d -o root -g "$nginx_group" -m 0755 /var/www/acme /var/www/acme/.well-known /var/www/acme/.well-known/acme-challenge
if [[ ! -f /etc/wecom-finance/report-board.env ]]; then
  install -o root -g wecom-finance -m 0640 "$script_dir/.env.production.example" /etc/wecom-finance/report-board.env
fi
install -o root -g root -m 0644 "$script_dir/systemd/wecom-finance-report-board.service" /etc/systemd/system/
install -o root -g root -m 0644 "$script_dir/systemd/wecom-finance-backup.service" /etc/systemd/system/
install -o root -g root -m 0644 "$script_dir/systemd/wecom-finance-backup.timer" /etc/systemd/system/
install -o root -g root -m 0644 "$script_dir/nginx/wecom-finance.conf" /etc/wecom-finance/wecom-finance.nginx.conf
systemctl daemon-reload
echo "ECS 基础目录与服务文件已准备，但尚未启动应用或启用备份。下一步编辑环境文件，并在证书就绪后安装 Nginx 配置。"
