#!/usr/bin/env bash
set -euo pipefail

expected_root=/data/data/wecom-finance-report-board
requested_root=${1:-$expected_root}
finance_uid=20117
finance_gid=20117

if [[ $EUID -ne 0 ]]; then echo "请使用 root 执行财务数据目录加固" >&2; exit 1; fi
if [[ "$requested_root" != "$expected_root" ]]; then echo "拒绝处理非固定财务目录：$requested_root" >&2; exit 1; fi
mkdir -p -- "$expected_root"
resolved_root=$(readlink -f -- "$requested_root")
if [[ "$resolved_root" != "$expected_root" || "$resolved_root" == / || "$resolved_root" == /data || "$resolved_root" == /data/data ]]; then
  echo "财务数据目录解析结果不安全：$resolved_root" >&2
  exit 1
fi

if find "$resolved_root" -xdev -type l -print -quit | grep -q .; then
  echo "财务数据目录包含符号链接，拒绝继续" >&2
  exit 1
fi
chown -R ${finance_uid}:${finance_gid} -- "$resolved_root"
find "$resolved_root" -xdev -type d -exec chmod 0700 -- {} +
find "$resolved_root" -xdev -type f -exec chmod 0600 -- {} +

echo "财务数据目录已加固：$resolved_root · uid/gid ${finance_uid}:${finance_gid} · 目录 0700 · 文件 0600"
