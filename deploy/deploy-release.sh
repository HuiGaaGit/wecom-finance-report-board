#!/usr/bin/env bash
set -euo pipefail

artifact=${1:-}
if [[ $EUID -ne 0 ]]; then echo "请使用 root 执行" >&2; exit 1; fi
if [[ -z "$artifact" || ! -f "$artifact" ]]; then echo "用法：deploy-release.sh <release.zip>" >&2; exit 1; fi

app_root=/opt/wecom-finance
state_root=/var/lib/wecom-finance
env_file=/etc/wecom-finance/report-board.env
if [[ ! -f "$env_file" ]]; then echo "缺少 $env_file" >&2; exit 1; fi

version=$(python3 - "$artifact" <<'PY'
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    print(json.loads(archive.read('package.json'))['version'])
PY
)
release="$app_root/releases/$version-$(date +%Y%m%d%H%M%S)"
previous=$(readlink -f "$app_root/current" 2>/dev/null || true)
mkdir -p "$release" "$state_root/uploads" "$state_root/backups"
python3 - "$artifact" "$release" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2])
PY
cd "$release"
npm ci --omit=dev --ignore-scripts=false
node deploy/check-readiness.mjs --env "$env_file"
chown -R wecom-finance:wecom-finance "$release" "$state_root"
ln -sfn "$release" "$app_root/current"
systemctl daemon-reload
systemctl restart wecom-finance-report-board.service

if ! curl --fail --silent --show-error --retry 10 --retry-delay 2 --retry-connrefused http://127.0.0.1:3180/api/health >/dev/null; then
  echo "健康检查失败，开始回滚" >&2
  if [[ -n "$previous" && "$previous" == "$app_root"/releases/* ]]; then
    ln -sfn "$previous" "$app_root/current"
    systemctl restart wecom-finance-report-board.service
  else
    systemctl stop wecom-finance-report-board.service
  fi
  exit 1
fi
systemctl enable wecom-finance-report-board.service wecom-finance-backup.timer
systemctl start wecom-finance-backup.timer
echo "Deployed wecom-finance-report-board v$version to $release"
