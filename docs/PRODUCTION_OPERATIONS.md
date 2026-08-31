# 桉侨财务模块生产说明

更新日期：2026-08-31
当前版本：1.1.12
正式地址：<https://anqiaoyiminxq.com/platform/finance/>

## 1. 系统归属与隔离

财务模块归入桉侨小Q统一登录体系，但业务服务、源码、Docker 网络、数据库和上传文件均保持独立。财务模块不导入小Q源码、不直连小Q数据库，也不与 CRM 或其他业务模块共享数据卷。

财务模块只通过同域 HTTPS 接口调用小Q：

- `GET /api/auth/me`：确认当前登录用户及企微 UserID。
- `GET /api/data-dist/my-roles`：读取当前用户在小Q中的成员组。
- `GET /api/data-dist/user-groups`：仅管理员登录或手动同步时读取成员目录。

允许进入财务模块的小Q成员组固定为：

- `admin`：管理员
- `general_manager`：总经理
- `finance`：财务组

截至 2026-08-31，小Q“财务”成员组中有 4 人：

- Jet马云杰
- Wing劳思咏
- Chloe黎艺妍
- Hewson许嘉杰

这份名单以小Q成员权限中的 `finance` 分组为唯一来源；以后在小Q中增删成员即可，不需要修改财务模块配置或重新部署。

小Q成员组只决定能否进入财务模块。进入后可查看的公司、会计期间、报表、明细、上传和管理功能，继续由财务模块自己的细粒度权限控制。

## 2. 登录流程

1. 用户打开财务地址。服务端只返回不含财务数据的静态登录引导页。
2. 页面读取同域中小Q保存的 `aqllm_tob_auth` 登录状态。
3. 没有小Q登录状态时，页面记录安全回跳地址 `/finance/`，然后前往 `/platform/login`。
4. 已登录时，页面把小Q访问令牌发送到财务模块的 `POST /api/auth/platform-session`。
5. 财务服务调用小Q身份与成员组接口。只有三个授权组之一的用户才能换取财务会话。
6. 财务服务设置 15 分钟有效的 HttpOnly、SameSite=Lax、Secure 会话 Cookie。Cookie 不包含小Q令牌；到期后页面会使用当前小Q登录状态重新校验成员组。

旧财务自建应用、旧 `agentid=1000045`、独立企微 OAuth 回调、企微应用 Secret 和可信 IP 配置均不再参与财务登录。

## 3. 服务器与目录

服务器：`8.163.36.95`

| 用途 | 生产路径 |
| --- | --- |
| 财务源码 | `/data/repos/wecom-finance-report-board` |
| Docker Compose 编排 | `/data/opt/wecom-finance-report-board/compose.yml` |
| 生产环境变量 | `/data/secrets/wecom-finance-report-board/report-board.env` |
| 持久数据根目录 | `/data/data/wecom-finance-report-board` |
| SQLite 主库 | `/data/data/wecom-finance-report-board/report-board.db` |
| 上传原文件与解析快照 | `/data/data/wecom-finance-report-board/uploads` |
| 数据库备份 | `/data/data/wecom-finance-report-board/backups` |
| Nginx 财务路由 | `/etc/nginx/snippets/wecom-finance-report-board.conf` |
| AQLLM Nginx 主站配置 | `/etc/nginx/conf.d/aqllm-3.0.conf` |
| 小Q源码（只作为依赖系统） | `/data/repos/aqllm` |
| 小Q当前前端静态版本 | `/data/web/aqllm/current` |

环境变量文件权限应保持 `0600`，不得提交到 Git 或复制到说明文档。

## 4. Docker 运行方式

- Compose 项目：`wecom-finance-report-board`
- 容器：`wecom-finance-report-board`
- 镜像：`aqllm/finance-report-board:1.1.12`
- 容器端口：`3180`
- 主机监听：`127.0.0.1:3180`
- Docker 网络：`wecom-finance-report-board`
- 数据卷：主机 `/data/data/wecom-finance-report-board` 挂载到容器 `/var/lib/wecom-finance`

端口只监听回环地址，公网不能直接访问 3180。外部请求必须经 Nginx 的 `/platform/finance/` 路由进入。

常用检查：

```bash
docker ps --filter name=wecom-finance-report-board
docker logs --tail 200 wecom-finance-report-board
curl -fsS http://127.0.0.1:3180/api/health
docker compose -f /data/opt/wecom-finance-report-board/compose.yml ps
```

## 5. 数据库如何访问

财务数据库是 SQLite 文件，不是独立数据库服务，因此没有数据库主机名、账号、密码或 TCP 端口。应用通过容器内路径 `/var/lib/wecom-finance/report-board.db` 访问，主机上的实际文件是 `/data/data/wecom-finance-report-board/report-board.db`。

查看数据库完整性、表名和每张表的行数，不读取业务明细：

```bash
docker exec wecom-finance-report-board node deploy/database-summary.mjs
```

业务写入必须通过财务应用接口完成，不应在运行中直接修改 SQLite。确需人工 SQL 排查时，先创建一致性备份，把备份文件复制到隔离目录后只读分析。

手动创建 SQLite 一致性备份：

```bash
docker exec wecom-finance-report-board node deploy/backup-database.mjs
```

SQLite 运行时可能同时存在 `report-board.db-wal` 和 `report-board.db-shm`。不能只复制正在运行的主库文件作为备份；应使用上面的备份脚本。

## 6. 各类数据的位置

### 6.1 SQLite 数据

`report-board.db` 保存：

- 员工目录、角色、个人权限档案和公司/期间数据范围。
- 公司、报表类型、模块顺序和分析板块顺序。
- 上传批次、校验状态、发布状态、版本快照和审计记录。
- 报表标准化数据、原始表快照索引、权限设置及应用设置。

### 6.2 上传文件

`uploads/` 保存用户上传的 Excel 原文件及系统解析生成的 JSON 快照。SQLite 中保存上传批次、文件路径、哈希、状态和版本关系。

发布新镜像或更新源码不会覆盖该目录。

### 6.3 备份

`backups/` 保存 SQLite 一致性备份。备份文件名包含创建时间。恢复前应停止财务容器，并同时保留被替换数据库的副本。

### 6.4 登录与成员组数据

小Q访问令牌只存在用户浏览器的小Q登录存储中，财务数据库不保存访问令牌或刷新令牌。财务数据库只保存企微 UserID、显示名称、所属授权组摘要和财务内部权限。

### 6.5 密钥与配置

`/data/secrets/wecom-finance-report-board/report-board.env` 保存财务会话签名密钥、路径和小Q API 地址。当前版本不需要旧财务企微应用的 CorpID、AgentID 或 Secret。

## 7. 发布与回滚

发布前：

```bash
cd /data/repos/wecom-finance-report-board
node deploy/check-readiness.mjs --env /data/secrets/wecom-finance-report-board/report-board.env
docker build --target tests -t aqllm/finance-report-board:test .
docker build -t aqllm/finance-report-board:1.1.12 .
```

发布：

```bash
docker compose -f /data/opt/wecom-finance-report-board/compose.yml up -d --no-build
curl -fsS http://127.0.0.1:3180/api/health
nginx -t
```

回滚时把 Compose 镜像标签改回上一已验证版本，然后重新 `up -d`。数据库与上传目录独立于镜像，不随镜像回滚。若本次版本包含数据结构变更，应先根据对应版本说明判断是否同时恢复数据库备份。

## 8. 故障判断

- 打开后进入小Q登录页：浏览器没有有效小Q登录状态，属于正常流程。
- 已登录仍显示无访问权限：检查该人的小Q成员组是否包含管理员、总经理或财务组。
- 能进入但看不到报表：检查财务模块内部的员工权限档案、公司范围和期间范围。
- 返回 502 或提示小Q认证服务不可用：检查主站 `/api/auth/me`、`/api/data-dist/my-roles` 和财务容器到主域名的 HTTPS 连通性。
- 页面正常但数据缺失：检查 `uploads/` 文件、上传批次状态和已发布版本，不要从源码目录寻找业务数据。

## 9. 平台迁移基线验收（1.1.11）

- 正式镜像：`aqllm/finance-report-board:1.1.11`
- 容器健康状态：`healthy`
- 完整 Docker 回归测试：66 项全部通过
- 真实成员组验证：管理员、总经理、财务组均能登录并读取财务页面；组外账号返回 403
- SQLite 完整性检查：`ok`
- 现存核心数据：8 家公司、68 个上传批次、68 份报表快照、3,431 条报表行
- Nginx 配置检查：通过
- 发布前数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-pre-platform-auth-1.1.11.db`
- 发布前源码、编排及密钥配置备份：`/data/backups/wecom-finance-report-board/platform-auth-before-1.1.11-20260831T074500Z`

## 10. 业务合并发布验收（1.1.12）

- GitHub、部署服务器和本地源码提交：`84fccd84756fa16d4f0bb1a8d90338652462206d`。
- 正式镜像：`aqllm/finance-report-board:1.1.12`；镜像 ID：`sha256:bcebf8ac51937ba5d227e5a4d01954cb110c7a58d99fd5cd66733e4d79636015`。
- 本地与服务器 Node 20 容器回归：69 项全部通过。
- 回环及公网健康接口均返回 `version=1.1.12`、`authMode=platform`；容器状态为 `healthy`，Nginx 配置检查通过。
- SQLite 完整性检查：`ok`；核心数据仍为 8 家公司、68 个上传批次、68 份报表快照、3,431 条报表行。
- 发布前数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-20260831T091901Z.db`。
- 发布后数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-20260831T092326Z.db`。
- 发布前 Compose 备份：`/data/opt/wecom-finance-report-board/compose.yml.pre-1.1.12-20260831T1718`。
- 生产源码原有平台化改动已保存到 Git stash `pre-v1.1.12-platform-source-20260831`，用于审计与回退比对。
- 部署后备份核对到“财务数据简报”排序 10、“资产负债表”排序 20，两项模块排序迁移标记均为 1；管理员后续保存的完整全局顺序继续持久化。
