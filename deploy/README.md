# 生产部署

正式环境采用独立 Docker Compose 部署，不再使用旧财务自建应用、独立企微 OAuth 或 systemd 服务。

- 源码：`/data/repos/wecom-finance-report-board`
- 编排：`/data/opt/wecom-finance-report-board/compose.yml`
- 环境变量：`/data/secrets/wecom-finance-report-board/report-board.env`
- 持久数据：`/data/data/wecom-finance-report-board`
- 容器：`wecom-finance-report-board`
- 当前生产镜像：`aqllm/finance-report-board:1.1.14`（生产验收与回滚信息见 `docs/PRODUCTION_OPERATIONS.md`）
- 本机端口：`127.0.0.1:3180`
- 正式地址：`https://anqiaoyiminxq.com/platform/finance/`

财务模块通过小Q的 `/api/auth/me` 和 `/api/data-dist/my-roles` 校验登录身份及管理员、总经理、财务组三个成员组。生产环境不保存企微应用 Secret。

部署前执行：

```bash
cd /data/repos/wecom-finance-report-board
node deploy/check-readiness.mjs --env /data/secrets/wecom-finance-report-board/report-board.env
docker build --target tests -t aqllm/finance-report-board:test .
docker compose -f /data/opt/wecom-finance-report-board/compose.yml up -d --build
curl -fsS http://127.0.0.1:3180/api/health
nginx -t
```

完整的认证、数据库、数据目录、备份和恢复说明见 [`../docs/PRODUCTION_OPERATIONS.md`](../docs/PRODUCTION_OPERATIONS.md)。
