# 项目 17 运维约定

## 适用范围

- 本文件及 `deploy/ssh_config` 只适用于 `17企微财务报表看板` 目录及其相关 Codex 对话。
- 其他项目或工作区级对话不得使用 `wecom-finance-prod`，也不得连接 `8.163.36.95`；除非用户针对该项目另行明确授权并提供对应事实源。

## 生产服务器

- 本项目唯一正式生产服务器使用项目内 `deploy/ssh_config` 的 SSH 别名 `wecom-finance-prod`，标准入口为 `ssh -F deploy/ssh_config wecom-finance-prod`。
- 该配置固定连接 `root@8.163.36.95`，使用 `C:/Users/ASUS/.ssh/hermes_aliyun_ed25519`、`IdentitiesOnly yes`、`BatchMode yes` 和严格主机密钥校验实现免密认证。
- 开始生产操作前必须读取 `docs/PRODUCTION_OPERATIONS.md`，并先执行 `ssh -F deploy/ssh_config wecom-finance-prod "hostname && whoami"` 做只读预检。
- 不得再向旧服务器 `8.163.95.203` 部署项目 17，也不得恢复旧 ZIP、systemd 或独立企微 OAuth 发布链路；旧记录仅用于历史审计。

## 生产事实源

- 正式地址：`https://anqiaoyiminxq.com/platform/finance/`。
- 源码：`/data/repos/wecom-finance-report-board`。
- Compose：`/data/opt/wecom-finance-report-board/compose.yml`。
- 环境文件：`/data/secrets/wecom-finance-report-board/report-board.env`。
- 持久数据：`/data/data/wecom-finance-report-board`。
- 容器：`wecom-finance-report-board`。
- 认证模式：`AUTH_MODE=platform`。

## 安全规则

- 不读取、打印、提交或复制生产环境文件中的 Secret。
- 数据库和上传资料必须继续通过独立 bind mount 保存，不得用源码同步或镜像发布覆盖。
- 部署前创建 SQLite 一致性备份并保留当前 Compose；部署后验证容器 healthy、回环及公网健康接口、Nginx、数据库摘要和 Git 提交一致性。
