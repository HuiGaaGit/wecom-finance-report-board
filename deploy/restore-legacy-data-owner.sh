#!/usr/bin/env bash
set -euo pipefail

expected_root=/data/data/wecom-finance-report-board
requested_root=${1:-$expected_root}

if [[ $EUID -ne 0 ]]; then echo "请使用 root 执行旧镜像 owner 回滚" >&2; exit 1; fi
if [[ "$requested_root" != "$expected_root" ]]; then echo "拒绝处理非固定财务目录：$requested_root" >&2; exit 1; fi
resolved_root=$(readlink -f -- "$requested_root")
if [[ "$resolved_root" != "$expected_root" || "$resolved_root" == / || "$resolved_root" == /data || "$resolved_root" == /data/data ]]; then
  echo "财务数据目录解析结果不安全：$resolved_root" >&2
  exit 1
fi
if find "$resolved_root" -xdev -type l -print -quit | grep -q .; then echo "财务数据目录包含符号链接，拒绝继续" >&2; exit 1; fi
chown -R 1000:1000 -- "$resolved_root"
echo "已把精确财务目录 owner 恢复为旧镜像所需的 1000:1000；0700/0600 权限保持不变"
