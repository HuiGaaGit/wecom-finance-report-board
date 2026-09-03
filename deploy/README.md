# 生产部署

正式环境采用独立 Docker Compose 部署，不再使用旧财务自建应用、独立企微 OAuth 或 systemd 服务。

- 源码：`/data/repos/wecom-finance-report-board`
- 编排：`/data/opt/wecom-finance-report-board/compose.yml`
- 环境变量：`/data/secrets/wecom-finance-report-board/report-board.env`
- 持久数据：`/data/data/wecom-finance-report-board`
- 容器：`wecom-finance-report-board`
- 当前生产镜像：`aqllm/finance-report-board:1.1.33`（生产验收与回滚信息见 `docs/PRODUCTION_OPERATIONS.md`）
- 当前源码版本：`1.1.34`（财务简报二级说明改为自由文字并补齐删除交互，待验证部署）
- 本机端口：`127.0.0.1:3180`
- 正式地址：`https://anqiaoyiminxq.com/platform/finance/`

异机备份使用 `offsite-backup.sh` 和 `systemd/wecom-finance-offsite-backup.*`，由新服务器每 8 小时推送到旧服务器；旧服务器的 90 天保留策略使用 `offsite-retention.sh` 和 `systemd/wecom-finance-offsite-retention.*`。这组单元与旧服务器原有 `wecom-finance-backup.timer` 完全独立。

财务模块只以无正文 GET 请求调用小Q的 `/api/auth/me`、`/api/data-dist/my-roles` 和管理员目录同步所需的 `/api/data-dist/user-groups`。生产环境不保存企微应用 Secret，也不把报表、工资、上传文件或解析结果发送给小Q。

`1.1.25` 使用专用运行身份 `20117:20117`。首次切换前先创建 SQLite 一致性备份，再执行 `deploy/harden-finance-data.sh`；该脚本只接受精确目录 `/data/data/wecom-finance-report-board`。SQLite 备份和异机备份状态文件均按 `0600` 创建。启动后必须执行 `node deploy/check-runtime-isolation.mjs`，验证 owner/mode、其他容器挂载、Docker Socket、网络成员和回环端口。

部署前执行：

```bash
cd /data/repos/wecom-finance-report-board
node deploy/check-readiness.mjs --env /data/secrets/wecom-finance-report-board/report-board.env
docker build --target tests -t aqllm/finance-report-board:test .
sudo bash deploy/harden-finance-data.sh /data/data/wecom-finance-report-board
docker compose -f /data/opt/wecom-finance-report-board/compose.yml up -d --build
curl -fsS http://127.0.0.1:3180/api/health
node deploy/check-runtime-isolation.mjs
nginx -t
```

正式切换不需要新增 DNS、证书或登录桥接；将 `nginx/platform-finance.conf` 安装到现有主站，在 `/platform/finance/` 代理财务服务。该路径关闭访问日志、请求/响应缓冲和代理缓存，并拒绝回环、同机公网地址及私网服务端来源。注意：同一 Origin 无法隔离小Q前端脚本或根作用域 Service Worker。

完整的认证、数据库、数据目录、备份和恢复说明见 [`../docs/PRODUCTION_OPERATIONS.md`](../docs/PRODUCTION_OPERATIONS.md)。
