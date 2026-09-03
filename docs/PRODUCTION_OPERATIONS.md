# 桉侨财务模块生产说明

更新日期：2026-09-03
当前生产版本：1.1.35
最近发布包：1.1.35（已部署）
正式地址：<https://anqiaoyiminxq.com/platform/finance/>

## 1. 系统归属与隔离

财务模块归入桉侨小Q统一登录体系，但业务服务、源码、Docker 网络、运行用户、数据库和上传文件均保持独立。财务模块不导入小Q源码、不直连小Q数据库，也不与 CRM 或其他业务模块共享数据卷。正式入口继续是主站下的 `/platform/finance/` 路径，不新增独立域名。

财务模块只通过 HTTPS 以无正文 GET 请求调用小Q身份白名单：

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

同机隔离边界：正常运行的小Q及普通业务容器不能读取财务卷、Docker 网络、接口响应或代理正文；Nginx 还拒绝回环、同机公网地址和私网服务端来源。由于财务与小Q共享 Origin，小Q页面脚本、XSS 或根作用域 Service Worker 仍可能读取浏览器可见的财务响应；同机 `root`、Docker daemon、内核完全失陷也可越过边界。若需覆盖这些威胁，必须把财务系统迁移到独立 Origin 或独立服务器。

## 2. 登录流程

1. 用户打开主站下的 `/platform/finance/`；未建立财务会话时跳转 `/platform/login`。
2. 财务页面仅在交换会话时读取同源小Q `aqllm_tob_auth` 中的短期 `accessToken`，不读取、刷新或复制 `refreshToken`，也不写入该存储。
3. 页面把短期令牌发送到同 Origin 的 `POST /platform/finance/api/auth/platform-session`；财务服务只调用三个小Q身份白名单接口。
4. 财务服务设置 15 分钟有效、Path 为 `/platform/finance` 的 HttpOnly、SameSite=Strict、Secure 会话 Cookie。Cookie 不包含小Q令牌；到期后重新返回小Q登录。

旧财务自建应用、旧 `agentid=1000045`、独立企微 OAuth 回调、企微应用 Secret 和可信 IP 配置均不再参与财务登录。

## 3. 服务器与目录

服务器：`8.163.36.95`

项目内免密 SSH 配置：`deploy/ssh_config`，主机别名为 `wecom-finance-prod`。标准登录与预检命令：

```powershell
ssh -F deploy/ssh_config wecom-finance-prod
ssh -F deploy/ssh_config wecom-finance-prod "hostname && whoami"
```

| 用途 | 生产路径 |
| --- | --- |
| 财务源码 | `/data/repos/wecom-finance-report-board` |
| Docker Compose 编排 | `/data/opt/wecom-finance-report-board/compose.yml` |
| 生产环境变量 | `/data/secrets/wecom-finance-report-board/report-board.env` |
| 持久数据根目录 | `/data/data/wecom-finance-report-board` |
| SQLite 主库 | `/data/data/wecom-finance-report-board/report-board.db` |
| 上传原文件与解析快照 | `/data/data/wecom-finance-report-board/uploads` |
| 数据库备份 | `/data/data/wecom-finance-report-board/backups` |
| Nginx 财务路径配置 | `/etc/nginx/snippets/wecom-finance-report-board.conf` |
| AQLLM Nginx 主站配置 | `/etc/nginx/conf.d/aqllm-3.0.conf` |
| 小Q源码（只作为依赖系统） | `/data/repos/aqllm` |
| 小Q当前前端静态版本 | `/data/web/aqllm/current` |

环境变量文件权限应保持 `0600`，不得提交到 Git 或复制到说明文档。
持久数据根目录 owner 必须为 `20117:20117`，目录必须为 `0700`、普通文件必须为 `0600`。

## 4. Docker 运行方式

- Compose 项目：`wecom-finance-report-board`
- 容器：`wecom-finance-report-board`
- 当前镜像：`aqllm/finance-report-board:1.1.35`
- 容器运行用户：`20117:20117`
- 容器端口：`3180`
- 主机监听：`127.0.0.1:3180`
- Docker 网络：`wecom-finance-report-board`
- 数据卷：主机 `/data/data/wecom-finance-report-board` 挂载到容器 `/var/lib/wecom-finance`

端口只监听回环地址，公网和其他 Docker 容器不能直接访问 3180。外部请求必须经主站 `/platform/finance/` 路径进入。财务 Nginx 关闭访问日志、请求/响应缓冲和代理缓存，并拒绝服务器自身公网地址、回环地址及 Docker/内网地址直接访问。

常用检查：

```bash
docker ps --filter name=wecom-finance-report-board
docker logs --tail 200 wecom-finance-report-board
curl -fsS http://127.0.0.1:3180/api/health
docker compose -f /data/opt/wecom-finance-report-board/compose.yml ps
node /data/repos/wecom-finance-report-board/deploy/check-runtime-isolation.mjs
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

小Q刷新令牌只存在用户浏览器的小Q登录存储中；同源财务页面仅在交换会话时读取短期 `accessToken`，不调用 `localStorage.setItem`，不读取或刷新 `refreshToken`。财务数据库、上传目录和应用日志均不保存访问令牌或刷新令牌。财务数据库只保存企微 UserID、显示名称、所属授权组摘要和财务内部权限。

### 6.5 密钥与配置

`/data/secrets/wecom-finance-report-board/report-board.env` 保存财务会话签名密钥、路径和小Q API 地址。当前版本不需要旧财务企微应用的 CorpID、AgentID 或 Secret。

## 7. 发布与回滚

发布前不创建独立域名、DNS 或证书；先备份现有主站 Nginx、Compose、环境文件和 SQLite，再执行只读检查：

```bash
cd /data/repos/wecom-finance-report-board
node deploy/check-readiness.mjs --env /data/secrets/wecom-finance-report-board/report-board.env
docker build --target tests -t aqllm/finance-report-board:test .
docker exec wecom-finance-report-board node deploy/backup-database.mjs
docker inspect wecom-finance-report-board --format '{{.Config.Image}} {{.Config.User}}'
```

把当前 Compose、Nginx、环境文件与镜像标识复制到带时间戳的备份目录。确认主机 UID/GID `20117` 未被其他用途占用后，停止旧容器并迁移精确财务目录权限：

```bash
docker compose -f /data/opt/wecom-finance-report-board/compose.yml stop
bash deploy/harden-finance-data.sh /data/data/wecom-finance-report-board
docker build -t aqllm/finance-report-board:1.1.25 .
docker compose -f /data/opt/wecom-finance-report-board/compose.yml up -d --no-build
curl -fsS http://127.0.0.1:3180/api/health
node deploy/check-runtime-isolation.mjs
```

把 `deploy/nginx/platform-finance.conf` 安装到现有主站 Nginx include 目录后：

```bash
nginx -t
systemctl reload nginx
```

验收顺序：回环健康接口；运行时隔离检查；外部访问 `/platform/finance/`；同源登录会话；许可 Origin 正常；主站/同机来源被拒绝；上传与报表读取；SQLite `integrity_check`。同源路径无法从浏览器层区分小Q脚本与财务页面，不能把路径配置描述为绝对隔离。

回滚时先恢复备份的主站 Nginx、环境文件和 Compose，停止 `1.1.25` 容器并启动上一镜像；若上一镜像使用 UID/GID `1000:1000`，再执行 `bash deploy/restore-legacy-data-owner.sh /data/data/wecom-finance-report-board`。数据库与上传目录独立于镜像，不随镜像回滚；本版本没有需要回退的业务数据迁移，除非完整性检查失败，否则不得用旧备份覆盖现有业务数据。

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

## 11. 上传记录与工资来源修复发布验收（1.1.14）

- GitHub、部署服务器和本地源码提交：`b8af9f40498f74b7ab6a8044594e6457678df7c3`。
- 发布包：`artifacts/wecom-finance-report-board-1.1.14.zip`；SHA256：`9D92D4D67CAAA0DBF359DCF8411F583CEAB5E20358E57DA85690AAA60AF3A4BA`，服务器传输副本核验一致后已清理。
- 正式镜像：`aqllm/finance-report-board:1.1.14`；镜像 ID：`sha256:bd5c4074e4e58a182e469e57d02f37777ddc58edb5929d2a05628d72ad567546`。
- 本地与服务器 Node 20 容器回归均为 69 项全部通过；上传成功后会自动切到本次实际公司和月份的“待处理发布”，工资来源按所选期间定位工作表并保留实际字段映射。
- 回环及公网健康接口均返回 `version=1.1.14`、`authMode=platform`；容器状态为 `healthy`，正式首页返回 HTTP 200，Nginx 配置检查通过。
- SQLite 完整性检查为 `ok`；部署前后核心数据保持 8 家公司、88 个上传批次、88 份报表快照、4,635 条报表行。
- 发布前数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-20260901T010509Z.db`；发布后数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-20260901T010616Z.db`。
- 发布前 Compose 备份：`/data/opt/wecom-finance-report-board/compose.yml.pre-1.1.14-20260901T090509`；回滚时恢复该文件并重新执行 Compose `up -d --no-build`。

## 12. 旧服务器异机备份

- 备份源：新生产服务器 `8.163.36.95`；备份目标：旧服务器 `8.163.95.203`。旧服务器不运行当前项目，只保存恢复数据。
- 新服务器 timer：`wecom-finance-offsite-backup.timer`，每天北京时间 `00:15、08:15、16:15` 固定执行，`Persistent=true`；service 为 `wecom-finance-offsite-backup.service`。
- 每次任务先在当前容器中运行 `deploy/backup-database.mjs` 生成 SQLite 一致性快照，再用 rsync 经 SSH 22 端口增量推送；不启用 rsync daemon、不开放新端口、不使用 `--delete`。
- 旧服务器账号：`wecom-finance-backup`；备份根目录：`/var/backups/wecom-finance-report-board`，包含 `database/`、`uploads/`、`config/` 和 `manifests/`。目录权限为 0700，文件权限为 0600。
- 专用 SSH 公钥只接受来自 `8.163.36.95` 的连接，并由 `rrsync -wo` 限制为备份根目录的只写 rsync；交互式 shell、PTY 和端口转发均不可用。
- `uploads/` 长期保留且不自动删除；旧服务器 `wecom-finance-offsite-retention.timer` 每天执行，数据库、配置和清单保留 90 天。旧服务器原有 `wecom-finance-backup.timer` 保持独立运行，不得覆盖。
- 首次全量备份于 `2026-09-01 09:42 CST` 完成：55 个上传文件、约 29MB；数据库快照 SHA256 在两台服务器一致。隔离恢复的 SQLite `integrity_check` 为 `ok`，恢复副本包含 8 家公司、88 个上传批次、88 份报表快照和 4,635 条报表行。

常用检查：

```bash
systemctl status wecom-finance-offsite-backup.timer
systemctl start wecom-finance-offsite-backup.service
journalctl -u wecom-finance-offsite-backup.service -n 100 --no-pager
cat /data/data/wecom-finance-report-board/backups/offsite-last-success.meta
```

恢复时只从旧服务器复制所需快照到隔离目录，先核对 `manifests/` 中的 SHA256 并执行 SQLite `PRAGMA integrity_check`；未经单独确认不得直接覆盖新服务器生产数据库或上传目录。

## 13. 往来校验、顾问分析与权限中心发布验收（1.1.18）

- 发布时间：`2026-09-01 15:07 CST`；生产由 `1.1.14` 直接升级到 `1.1.18`。
- 发布包：`artifacts/wecom-finance-report-board-1.1.18.zip`；SHA256：`83D0B3506EFD889FE2019EB1F95BBC7FFB60E4781CC7EA6FBFFFBE1807C7D447`，服务器接收副本核验一致。
- 正式镜像：`aqllm/finance-report-board:1.1.18`；镜像 ID：`sha256:9cf8636d51fa09b765ab43a588a85071046c29b71995eb8a459a68801a7534c9`。
- 本地完整回归为 74/74；服务器 Docker tests 阶段 71 项通过，权限中心独立 3 项通过，合计 74/74。
- 回环与公网健康接口均返回 `version=1.1.18`、`authMode=platform`；容器状态为 `healthy`，正式首页返回 HTTP 200 且版本元数据为 `1.1.18`，Nginx 配置检查通过，容器日志无异常。
- SQLite 完整性为 `ok`；升级前后的业务事实保持 8 家公司、89 个上传批次、89 份报表快照和 4,724 条报表行。新增往来模块、权限中心和顾问分析只产生预期的模块、权限及设置种子行。
- 本次上线包含：七家公司 21 组只读往来校验及双方明细下钻、顾问投入产出扩展、权限中心界面、上传列表刷新保护；后端继续按公司、期间、模块和明细权限隔离。
- 发布前数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-20260901T065837Z.db`；SHA256：`2fdec1e6abb93cb8dc548117b9fbf506fdee97efbcb7d16e0ba9c3c21cf1b859`。
- 发布后数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-20260901T070855Z.db`；SHA256：`c1b4c284d57e868a9442b4231bba6264fa4061a92b7dcd2a801445b8e22cacbd`。
- 发布前 Compose 与源码备份：`/data/backups/wecom-finance-report-board/pre-1.1.18-20260901T145857`。回滚时先恢复该目录中的 `compose.yml` 并执行 Compose `up -d --no-build`；只有需要回退数据结构时才另行恢复数据库一致性备份。

## 14. 财务数据隔离发布（1.1.23）

- 版本基于已冻结的 `1.1.22`，保留管理员浏览日志、权限中心“全部不可见”和此前全部业务功能；2026-09-02 已从生产 `1.1.18` 切换。
- 新增专用 `20117:20117` 运行身份、`umask 077`、数据目录 `0700`/文件 `0600`、精确目录加固与旧镜像 owner 回滚脚本。
- 新增运行时隔离检查：任何其他容器挂载财务路径、任何容器挂载 Docker Socket、财务网络出现额外成员、财务容器连接额外网络、端口非回环或最小权限缺失时均失败退出。
- 正式入口恢复为 `https://anqiaoyiminxq.com/platform/finance/`，不创建独立域名、DNS、证书或登录桥接；同源登录只读取小Q短期 access token，财务会话 Cookie 限定 Path `/platform/finance`。
- 同源财务 Nginx 关闭访问日志、请求/响应缓冲、代理缓存和临时文件，并拒绝回环、同机公网地址及 Docker/内网服务端来源；应用继续提供 CSP、无缓存、防嵌入、COOP、CORP、无 Referrer 与 `worker-src 'none'`。
- 财务后台只允许三个固定小Q身份接口的无正文 GET 请求；工资表固定为内部敏感数据源，任何角色均不能通过通用报表接口整表浏览或导出。
- 明确剩余风险：同一 Origin 的小Q前端脚本、XSS 或根作用域 Service Worker 仍可能读取浏览器可见的财务响应；宿主机 `root`、Docker daemon 或内核失陷不在本候选防护范围。
- 生产服务器已完成 tests/runtime 镜像构建、`nginx -t`、reload 和 `check-runtime-isolation.mjs`；回环健康与外部正式地址均返回 `version=1.1.23`，容器为 `healthy`，正式首页 HTTP 200，独立域名 DNS 未创建。
- 发布包：`artifacts/security-isolation-path-final-2/wecom-finance-report-board-1.1.23.zip`；SHA256：`B8AE6F12D07C937DBE71DB0433CE224EA8D4C334660EB9AEA79E367633D6F488`。正式镜像 ID：`sha256:3419199cfe66a8b329ab62295c121c657b9ec5c3bf43715e8b92c2938777e360`。
- 发布前数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-20260902T024652Z.db`；SHA256：`e4ec05ebcfeb6f77425ecae0d686facd59d83995a69fa208af3d2a32d4458a5b`。发布后数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-20260902T025552Z.db`；SHA256：`e2f7b879007686955b0ce680f4cc9dbe02ebd620583ba74e336e5324701873f0`；两次完整性检查均为 `ok`。
- 发布前配置快照：`/data/backups/wecom-finance-report-board/pre-1.1.23-20260902T024652Z`；切换时旧 Compose/Nginx 快照分别为 `/data/opt/wecom-finance-report-board/compose.yml.pre-switch-1.1.23-20260902T025232Z`、`/etc/nginx/snippets/wecom-finance-report-board.conf.pre-switch-1.1.23-20260902T025232Z`；旧源码保留在 `/data/repos/wecom-finance-report-board-pre-1.1.23-20260902T025232Z`。

## 15. 分析子模块权限与交互优化发布（1.1.25）

- 发布时间：`2026-09-03 10:02 CST`；生产由 `1.1.23` 经短暂候选 `1.1.24` 升级到最终补丁版本 `1.1.25`。
- 发布包：`artifacts/wecom-finance-report-board-1.1.25.zip`；SHA256：`93CCD80DB5187657CACDDEB90D0C0D40B33937C3DE199A0CEF487E05915B7623`，服务器接收副本核验一致。
- 正式镜像：`aqllm/finance-report-board:1.1.25`；镜像 ID：`sha256:fa3cf276dfe4e107f72ad2bc1b37adf9de75f2d3dd14062e61a8999c0aa1c383`。
- 本地与服务器 Docker 回归均为 84/84；生产运行时隔离检查、`nginx -t`、回环和公网健康接口全部通过，正式首页返回 HTTP 200 且版本元数据为 `1.1.25`，容器为 `healthy`。
- SQLite 完整性为 `ok`；上线前后业务事实保持 8 家公司、88 个上传批次、88 份报表快照和 4,635 条报表行。分析布局顺序保持 37 行，升级未按默认值重置管理员布局；8 个权限档案中，拥有三类分析父权限的 4 个档案均已补齐对应子模块权限。
- 上线验收发现旧备份脚本把数据库备份和异机备份状态文件生成为 `0640`，与运行时 `0600` 隔离契约不一致；`1.1.25` 已统一生成权限并加固现有数据树，随后隔离检查通过。补丁前后数据库备份 SHA256 同为 `ea7581a800a8a9a9130893360228767162dc4453944c31e645b66d884fcaf34a`，未改变业务内容。
- 发布前一致性备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T015532Z.db`；切换补丁前备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T020123Z.db`；发布后备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T020201Z.db`，三者权限均为 `0600`。
- 发布前配置与源码快照：`/data/backups/wecom-finance-report-board/pre-1.1.24-20260903T015532Z`；Compose 回滚副本：`/data/opt/wecom-finance-report-board/compose.yml.pre-switch-1.1.25-20260903T020100Z`；上一候选源码保留在 `/data/repos/wecom-finance-report-board-pre-1.1.25-20260903T020100Z`。

## 16. 财务简报复制与二级备注候选（1.1.26，未部署）

- 简报卡片新增“复制纯文字”，标题、公司口径、一级项目与二级备注均以单换行连接，不产生项目间空行。
- 新增按公司、期间和一级项目隔离的 `financial_brief_notes` 表及备注新增、修改、删除接口；备注内容归一为单行 1 至 300 字，保存操作写入审计日志。
- 权限中心新增“编辑二级项目备注”权限。管理员、财务负责人角色默认开启；服务端仍逐请求校验简报浏览权、备注编辑权以及公司与期间范围。
- 本候选由并行的资产负债分析任务继续合并到后续版本后统一部署；生产仍保持 `1.1.25`，不得把本候选单独切换到生产。

## 17. 资产负债分析与财务简报合并发布（1.1.27）

- 完整包含 `1.1.26` 的财务简报纯文字复制、二级备注及独立授权能力。
- 资产负债表右上方新增“资产负债分析”按钮；弹窗展示资金规模、来源/去向项目数、勾稽差额，以及两张二维环形构成图和金额/占比图例。
- 分析接口复用资产负债表汇总查看权限，每次直接读取所选公司、期间的当前已发布上传批次，响应禁止缓存；弹窗打开、手动刷新及保持打开每 60 秒均重新校验发布批次。
- 映射器按分析标题、项目/金额表头和合计行定位，不绑定固定行列；保留原项目名称、金额、源表行列和稳定分类键，未知新增项目不会静默丢失，缺表、缺合计或两侧差额会明确提示。
- 最终发布包：`artifacts/deploy-1.1.27/wecom-finance-report-board-1.1.27.zip`；SHA256：`7AC2DB763F697BA3AE3F6DB8F0D624DCE2A2E344D4E172D09B0532F5B8A2B8E5`。本地完整回归 `89/89`，真实浏览器桌面与手机端验收通过。Docker 依赖阶段提供仅构建时使用的 Python、make 和 g++，确保 `better-sqlite3` 在预编译包不可用时仍可可靠构建，最终运行镜像不包含这些工具；Debian 与安全仓库支持构建参数覆盖，阿里云生产机使用就近镜像源。
- GitHub、部署服务器和本地源码基线提交：`b7c5bbe6c1d2b1805d5d18697e45694ce5eeef87`；发布包 SHA256 与服务端上传副本核验一致。
- 服务器 Docker tests 阶段使用 Node 20 完成 `89/89` 回归。正式镜像：`aqllm/finance-report-board:1.1.27`；镜像 ID：`sha256:134972a4d63e465f3ea695c585cc7318fe2bea8951ebbd09d1d80c6c9c79e65b`。
- 生产已于 `2026-09-03` 从 `1.1.25` 切换至 `1.1.27`。容器状态为 `healthy`；回环和公网健康接口均返回 `version=1.1.27`、`authMode=platform`，新增 JS 与两份 CSS 公网资源均返回 HTTP 200，Nginx 配置与运行时隔离检查通过。
- SQLite 完整性为 `ok`；核心业务事实保持 8 家公司、88 个上传批次、88 份报表快照和 4,635 条报表行。新增 `financial_brief_notes` 表当前为 0 行，发布未改写历史报表数据。
- 发布前数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T044128Z.db`；SHA256：`3003f60691d99920cf1bd9a744f4cbe301f441546ccb818fd4793f1c6c643f90`。发布后数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T050045Z.db`；SHA256：`a7c012afea1440aa8e81b602ab419d84d793ffa10012f93491c2d22ad659b0b6`。两份备份权限均为 `0600`。
- 发布前源码与 Compose 回滚快照：`/data/backups/wecom-finance-report-board/pre-1.1.27-20260903T044128Z`。回滚时恢复该快照中的 Compose，并重新执行 `docker compose up -d --no-build`；除非数据库完整性失败，不得用旧数据库覆盖当前业务数据。

## 18. 财务简报明细行与资产负债分析表图联动发布（1.1.29）

- 原自由文字备注卡片改为一级项目下方的二级项目明细行，每行包含项目名称与金额，沿用一级项目的列对齐并缩小一号字体，不显示“备注”标签、作者或独立卡片边框。
- 新增与编辑表单分别录入二级项目名称和金额；纯文字复制时二级项目紧跟所属一级项目，全部项目之间不插入空行。
- “营收综合利润”作为最终结果固定不提供二级项目，前端不显示入口，后端也拒绝绕过界面新增。
- 权限键保持 `module.financial_brief.notes.manage` 以兼容现有授权，权限中心展示名称更新为“编辑二级项目明细”。SQLite 继续复用 `financial_brief_notes` 表并增量增加名称、金额字段，不重建数据库；若历史备注存在，会把原文字兼容迁移为二级项目名称。
- 资产负债分析移除顶部资金规模、项目数、差额四张概览卡及独立勾稽标签；两侧按上传原顺序完整展示源表项目、金额和合计，无金额项目保留短横线。
- 每个正数项目与图表扇区使用稳定标识关联。点击表格行或扇区后，对应扇区动画放大、其他扇区弱化，圆心切换为项目名称、占比和准确金额；支持键盘 Enter/空格选择和屏幕阅读器动态播报。
- 本版本基于已提交的 `1.1.28` 财务简报变更继续递增为 `1.1.29`。源码功能提交：`73d5fe746e7d01315672ccb02101e2ed73a7c749`；发布包：`artifacts/wecom-finance-report-board-1.1.29.zip`，SHA256：`2D3F058935C54194F5FB1E9FB9077D7FD173E7E38C3F888F81C663DFBE9FD3FA`，服务端副本核验一致。
- 本地与服务器 Node 20 Docker tests 完整回归均为 `90/90`；正式镜像：`aqllm/finance-report-board:1.1.29`，镜像 ID：`sha256:eb53acc64cd5fec10490b177c8b1cad55bf4016964451521c876944bde5de45f`。
- 生产已于 `2026-09-03` 从 `1.1.27` 切换到 `1.1.29`。容器状态为 `healthy`，回环和公网健康接口均返回 `version=1.1.29`、`authMode=platform`；新增资产分析 JS/CSS 公网资源返回 HTTP 200，Nginx 配置和运行时隔离检查通过。
- SQLite 完整性为 `ok`；核心业务事实保持 8 家公司、88 个上传批次、88 份报表快照和 4,635 条报表行，二级项目表当前为 0 行，增列迁移未改写历史报表数据。
- 发布前数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T061119Z.db`，SHA256：`7f7a8d31490394e2b10e6703cca856181e6e90442383abb626d45677a426651b`；发布后备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T061448Z.db`，SHA256：`6669c2f860af8532ffc7cfc98ac1f36af2520ed2e27d90edf4276d7db50d2d14`，两者权限均为 `0600`。
- 发布前源码与 Compose 回滚快照：`/data/backups/wecom-finance-report-board/pre-1.1.29-20260903T061103Z`。回滚时恢复该快照中的 Compose 并重新启动上一镜像；除非数据库完整性失败，不得用旧备份覆盖正常业务数据。

## 19. 财务简报二级项目入口交互发布（1.1.30）

- 不再在每个一级项目下方常驻显示“添加二级项目”文字行；授权人员悬停一级项目或用键盘聚焦时，仅在该项目左侧显示一个浮动 `+`，不占用正文高度。
- 点击 `+` 后，直接在一级项目下方展开与正文相同的名称、金额、操作三列填写行，不增加额外缩进或卡片容器。触屏设备保留低对比度浮动 `+`，确保没有悬停能力时仍可操作。
- 源码功能提交：`a43ee2d`；发布包：`artifacts/wecom-finance-report-board-1.1.30.zip`，SHA256：`380F1525A04571646026709902F5998F47A1228E657B211A999013B61FD0AC5D`，服务器接收副本核验一致。
- 本地与服务器 Node 20 Docker tests 完整回归均为 `90/90`；隔离空数据库冒烟返回 `version=1.1.30`、`authMode=platform`。正式镜像：`aqllm/finance-report-board:1.1.30`，镜像 ID：`sha256:4bc9d7788b22ef3b74970d06405c540c1514dec3fecb79b6a90d62634c0f15a3`。
- 生产已于 `2026-09-03` 从 `1.1.29` 切换到 `1.1.30`。容器为 `healthy`，回环和公网健康接口均返回 `1.1.30/platform`；Nginx 配置、运行时隔离和应用静态资源一致性检查通过。
- SQLite 完整性为 `ok`；上线前后核心业务事实保持 8 家公司、88 个上传批次、88 份报表快照和 4,635 条报表行，二级项目表仍为 0 行。
- 发布前数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T063002Z.db`，SHA256：`c7de2951413ec9f1b88cd4420dab213115ff777874238c20cc378a9dbbd9f446`；发布后备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T064207Z.db`，SHA256：`e9a386d727aa5c6517cf7a9e423e6d675cad4aafab021e53010c7bf1e2cc0059`，两者均为 `20117:20117`、权限 `0600`。
- 发布前源码与 Compose 回滚快照：`/data/backups/wecom-finance-report-board/pre-1.1.30-20260903T063931Z`。回滚时恢复该快照中的 Compose 并重新启动上一镜像；除非数据库完整性失败，不得用旧备份覆盖正常业务数据。

## 20. 首页公司卡片光标修复候选（1.1.31，待部署）

- 管理员首页公司卡片的普通悬停恢复为明确的点击手型，不再提前显示抓取光标；只有长按 460 毫秒并真正进入拖动态后，容器和卡片才统一显示抓取中光标。
- 保留整卡长按排序、短按选择和触屏手势逻辑，仅修正指针视觉状态；需完成真实浏览器悬停与长按回归后再部署。

## 21. 历史财务资料兼容导入候选（1.1.33，待部署）

- 基于 `1.1.32` 的财务简报入口优化、首页公司卡片光标修复和营收统计年度累计子表继续递增，保留全部既有功能。
- 兼容早期集团合并利润表主表使用通用“利润表”名称，并严格按上传时明确选择的普通集团口径或营收利润口径解析；不会误生成公司利润表批次。
- 兼容工资明细位于 `Sheet1` 等通用工作表名称的旧文件，按姓名、部门、基本工资、本月提成完整字段签名选取明细页。
- 汇总文件中的序时账和科目余额表新增实际期间校验；错月子表从批次中排除并返回诊断，期间正确的资产负债表、利润表和现金流量表仍可正常校验。
- 早期集团文件没有公司分表时保留集团主表并标记为无分表可勾稽；只要存在公司分表，仍须逐行加总一致才能发布。
- 历史目录隔离试解析识别 60 个候选文件，5 个生产已发布项跳过，其余 55 个文件预计形成 147 个新报表批次；正式上传和发布须在生产一致性备份及用户最终确认后执行。

## 22. 财务简报自由二级说明发布（1.1.34）

- 一级项目左侧浮动 `+` 比同行项目名称下移约半个字符，继续保持默认隐藏、悬停或键盘聚焦显示。
- 点击后仅展开一个最长 300 字的横向自由文字框，可填写纯文字、金额说明或两者混合，不再强制拆分“项目名称”和“金额”。
- 已保存说明支持编辑与确认删除，纯文字复制时仍紧跟所属一级项目且不插入空行；服务端继续校验权限、公司和期间范围并记录操作日志。
- 继续复用 `financial_brief_notes` 表和原权限键，旧名称金额数据按合并文本兼容显示，不重建或清空数据库。
- 功能提交为 `779a99c`，构建镜像源支持提交为 `da141c7`；最终发布包为 `artifacts/build-1.1.34-r2/wecom-finance-report-board-1.1.34.zip`，SHA256 为 `7BA27A3E627953112E1773A2E429AC2147147A032822B70E9B567CC0B3AB6283`，服务器上传副本核验一致。
- 本地与服务器 Docker tests 完整回归均为 `93/93`；独立空数据库冒烟返回 `version=1.1.34`、`authMode=platform`。正式镜像为 `aqllm/finance-report-board:1.1.34`，镜像 ID 为 `sha256:db28286bfeb331870e7975449d8f90542fca91d29e632faec310ea1ebde0bf7c`。
- 生产已于 `2026-09-03 16:19 CST` 从 `1.1.33` 切换到 `1.1.34`。容器为 `healthy`，回环健康接口返回 `1.1.34/platform`；未登录访问正式地址进入小Q统一登录流程，Nginx 配置、运行时隔离和应用静态资源一致性检查通过。
- SQLite 完整性为 `ok`；核心业务事实保持 8 家公司、88 个上传批次、88 份报表快照和 4,635 条报表行，二级说明表为 0 行。本次未写入生产测试说明；部署前发现异机备份状态文件权限为 `0640`，已按隔离契约收紧为 `0600`。
- 发布前数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T080257Z.db`，SHA256：`6ff0f77801b61e387041e06831e861d795c2adf2db9a048804c35f94add55894`；发布后备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T082406Z.db`，SHA256：`a7d1f6b6a2f4debb1ae244a16b421698442950eeb67dee084579ff8601a998a0`，两者均为 `20117:20117`、权限 `0600`。
- 发布前源码与 Compose 回滚快照：`/data/backups/wecom-finance-report-board/pre-1.1.34-20260903T081850Z`。回滚时恢复其中的源码和 Compose 并重新启动上一镜像；除非数据库完整性失败，不得用旧备份覆盖正常业务数据。

## 23. 历史财务资料生产补录（1.1.34 运行中）

- `2026-09-03` 已按源目录最后修改时间完成去重，并在用户确认包含工资敏感数据后，向正式地址上传 55 个历史工作簿：广州月报 14 个、深圳月报 11 个、集团普通合并利润表 11 个、集团营收利润口径 7 个、工资表 7 个、独立科目余额表 5 个。
- 55 个文件全部通过正式上传接口校验，共形成并发布 147 个新报表批次；广州 2025-02 的旧 1 月序时账/科目余额表及 2025-03 的旧 1 月科目余额表按实际期间排除，其余同文件有效报表正常发布。
- 本次发布后共有 235 个上传批次、235 份报表快照和 13,061 条报表行，SQLite 完整性为 `ok`；任务开始前遗留的 10 个广州 2026-06 待处理重复批次保持未发布，不属于本次补录。
- 首页刷新后广州、深圳、集团分别有 17、12、12 个可用期间。生产抽查广州 2025-02 利润表与错月序时账空态、广州 2025-05 科目余额表、深圳 2025-08 资产负债表、集团 2025-08 普通合并利润表、集团 2026-02 营收利润口径以及 2026-01 至 2026-07 七个月工资批次，来源文件、期间和报表类型均正确。
- 正式上传前一致性备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T084130Z.db`；发布后备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T085520Z.db`。当前容器保持 `aqllm/finance-report-board:1.1.34`、`healthy`，回环与公网健康接口均返回 `1.1.34/platform`。

## 24. 资产负债分析滑动表图发布（1.1.35）

- 移除“源表项目与金额”冗余说明；钱的来源与钱的去向不再并排显示，改为左侧页签控制表格和图表同步滑动切换。
- 左侧按上传原顺序显示紧凑项目/金额表，右侧扩大环形图空间；每个正数色块都用防碰撞引导线直接标注项目名称和比例。点击表格行、色块或标签会同步高亮、动画放大并在圆心显示比例和金额；自动刷新后保留当前来源/去向页签。
- 功能提交为 `6fd8d27`；发布包为 `artifacts/wecom-finance-report-board-1.1.35.zip`，SHA256 为 `95F4F307AAAEE7C0F21462803F46D7AB5DD54169FD5CD94B940AF59F36A27528`，服务器上传副本核验一致。
- 本地与服务器 Docker tests 完整回归均为 `94/94`；正式镜像为 `aqllm/finance-report-board:1.1.35`，镜像 ID 为 `sha256:4e2782a06d5b06b409e4304dbcd79299ccbbbcbf01267e6e3d9c66feaa9b24a5`。
- 生产已于 `2026-09-03 17:13 CST` 从 `1.1.34` 切换到 `1.1.35`。容器为 `healthy`，回环和公网健康接口返回 `1.1.35/platform`；Nginx、运行时隔离、正式页面及三份资产负债分析静态资源一致性检查通过。
- SQLite 完整性为 `ok`；核心业务事实保持 8 家公司、235 个上传批次、235 份报表快照和 13,061 条报表行，二级说明表仍为 0 行。
- 发布前数据库备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T090254Z.db`，SHA256：`8a10d0b6616b5da22c09ffcc8493dcf31bec7d9a122055770a3465b59e67539a`；发布后备份：`/data/data/wecom-finance-report-board/backups/report-board-20260903T091416Z.db`，SHA256：`80643bdd54290a325364d9dcd135feef4efae96ca07a051298aca239c20e24b8`，两者权限均为 `0600`。
- 发布前源码、Compose、Nginx 和受限环境配置回滚快照：`/data/backups/wecom-finance-report-board/pre-1.1.35-20260903T090245Z`。回滚时恢复快照并重新启动上一镜像；除非数据库完整性失败，不得用旧备份覆盖正常业务数据。

## 25. 全公司模块顺序候选（1.1.36，待部署）

- 管理员在任意公司左侧导航调整模块顺序后，服务端统一写入一份 `all_companies` 全局顺序；其他单家公司和桉侨集团均从同一顺序过滤各自可见模块，不产生公司级排序副本。
- 保存提示明确说明对所有公司和员工生效；无权限模块仍按员工授权隐藏，不因全局排序而扩大数据权限。
- 新增广州、深圳、桉侨集团三个范围的跨公司回归，防止后续把模块排序误改成公司级配置。完整回归 `94/94` 通过；发布包为 `artifacts/wecom-finance-report-board-1.1.36.zip`，SHA256 为 `4F98B027E946DCBFEDA102EEDC33BAC0C4834F75A6CFAA69E150157D26077252`。生产仍运行 `1.1.35`，尚未部署本候选。

## 26. 营收累计独立子模块候选（1.1.37，待部署）

- “营收统计表”左侧子导航扩展为四项，前三项只展示集团、单独直客、单独渠道当期统计，第四项“营收统计累计数据”独立展示年度累计内容。
- 第四项保留年份选择及 L1、L2、L2-1、L3、L4、L5、L6 子表切换；带括号的子表标题把口径名称换到第二行居中，并收紧按钮字号、间距和宽度，在标准桌面内容区内七项保持单行且无横向溢出。
- 数据解析继续依赖年度分区标题、子表标题、字段表头和相邻结构，不将第 168 行等固定坐标作为映射契约。完整回归 `94/94` 通过，真实浏览器已验证第四项选中态、当期/累计页面互斥和累计页签排版；生产仍运行 `1.1.35`，本候选尚未部署。

## 27. 顾问投入产出明细紧凑表格候选（1.1.38，待部署）

- 桌面端顾问投入产出明细取消固定宽度的实际约束，九列按业务重要度分配比例并完整铺满模块，无需左右拖动。
- 各列表头仅保留排序文字和漏斗按钮；筛选条件、升降序、应用及清除操作收进视口定位浮层，不参与表格列宽计算，已筛选列以高亮和状态点提示。
- 小于 `900px` 的窄屏仍保留表格内部横向滑动，避免数字过度压缩或重叠；页面和左侧导航本身不会被宽表撑开。
- 本候选继续包含 1.1.37 营收累计独立子模块、1.1.36 全公司全员工模块顺序及此前权限和安全隔离能力；生产仍运行 `1.1.35`，本候选尚未部署。

## 28. 顾问人事状态与通讯录字段候选（1.1.39，待部署）

- 顾问明细列顺序调整为顾问、入职日期、英文名、业绩归属和投入产出指标；入职日期只取当期已发布工资表，不以花名册覆盖。已离职顾问显示红色圆形“离职”，当月入职仍显示“新”。
- 英文名以企业微信通讯录为主，花名册英文名仅在通讯录缺失时兜底；两列可按现有 WPS 风格表头漏斗筛选、排序并进入当前视图 CSV。
- 财务应用只读同数据卷中的 `consultant-directory.json` 脱敏快照，最大 `512 KiB`、最多 `5000` 人，格式或大小异常时忽略快照并继续返回财务分析，不暴露文件路径或原始人事数据。
- 宿主机同步器只为已发布工资表中的顾问查询企业微信信息，输出字段固定为姓名、英文名、任职状态和同步时间。连接器返回列数超过姓名/英文名范围时默认拒绝落盘，避免身份证号等字段进入财务数据目录。
- 生产切换前先备份数据与 Compose，完成企业微信 CLI 独立授权并手工验证同步服务；同步未成功不阻断财务应用发布，只会显示“人事尚未同步”。回滚时停用 `wecom-finance-consultant-directory.timer` 并恢复上一镜像，旧版不会读取该快照。
- 本地受控同步验证仅生成 `3.3 KiB` 脱敏快照，人员记录只有 `name`、`englishName`、`employmentStatus` 三个字段；默认模式检测到连接器返回超范围列后以非零状态退出，并确认上一安全快照哈希未变化。
- `1440×900` 浏览器验收中 11 列表格内容宽度与容器同为 `1073px`，无桌面横向滚动；英文名漏斗筛选、红色圆形离职标识和入职日期列均正常。`390×844` 下页面本身无横向溢出，表格内部保留最低可读宽度滑动；控制台无警告或错误。

## 29. 顾问人事自动匹配与操作指引候选（1.1.40，待部署）

- 每月工资表或营收统计表发布成功后，财务应用在私有数据卷原子写入 `consultant-directory-refresh-request.json`。请求只含 schema、随机请求号、时间和固定原因，不含人员姓名、上传文件名、工资或营收金额。
- 宿主机 `wecom-finance-consultant-directory.path` 监听刷新请求并立即启动同步 service；timer 继续每小时兜底。同步器在 `consultant-directory-status.json` 写入执行中、成功、授权失效、来源范围异常、文档/通讯录权限不足、缺少顾问工资数据或一般错误状态，不写 CLI 原始输出和人员信息。
- 顾问页面把状态纳入数据版本签名。刷新执行中每 3 秒检查，完成后恢复每 60 秒检查；授权或来源问题会自动弹出具体处理步骤，也可从来源区再次打开并点击“重新匹配”。
- 本地联合回归 `98/98` 通过。受控真实企微同步成功读取 30 名顾问、28 个英文名和 7 个离职状态，快照人员对象仍只有 `name/englishName/employmentStatus`；模拟授权失效时退出码为 1、状态为 `auth_required`，浏览器在下一次 3 秒轮询自动弹出重新授权步骤。
- 合并后候选包为 `artifacts/consultant-directory-auto-final/wecom-finance-report-board-1.1.41.zip`，SHA256 为 `EABF6814607844C3103B1F354A4A6FA254CBB6CE171098D5B50A677B937E93BD`；包内源码与 UI 版本均为 `1.1.41`，包含 `.path` 和同步脚本且不含退役的独立域名桥接。
- 生产新增两个环境变量：`CONSULTANT_DIRECTORY_STATUS_FILE=/var/lib/wecom-finance/consultant-directory-status.json`、`CONSULTANT_DIRECTORY_REFRESH_REQUEST_FILE=/var/lib/wecom-finance/consultant-directory-refresh-request.json`。复制 `.service/.path/.timer` 后执行 `systemctl daemon-reload`，先手工启动 service 验证成功，再启用 path 与 timer。
- 回滚时先 `systemctl disable --now wecom-finance-consultant-directory.path wecom-finance-consultant-directory.timer`，恢复上一镜像和旧环境配置；保留或删除三个顾问目录 JSON 均不影响旧版本数据库。生产仍运行 `1.1.35`，本候选不得单独部署，由统一任务完成备份、Compose/Nginx 检查与公网验收。

## 30. 集团报单表客户与项目匹配候选（1.1.41，待部署）

- 上传页新增“集团报单表（客户及项目匹配）”入口。Excel 解析兼容“报价单、报价表、报单表”工作表，从前 50 行动态定位“合同编号、客户姓名、项目”，只保存去重后的三列匹配数据，不把原台账的合同金额、佣金等无关字段写入解析 JSON。
- 报单表属于全历史集团主数据，自动归入桉侨集团并使用独立“全历史”数据域；上传时无需选择会计月份。文件名开头的旧年月不参与上传或发布校验，用户可见版本号只取文件名末尾后缀（如 `-0903.xlsx` 为版本 `0903`），单条发布和批量发布规则一致。
- 主营业务分析读取最新已发布报单表，用规范化合同编号精确匹配并优先展示报单表客户、项目；收入、成本、毛利继续只取当前公司同期间序时账。未命中合同保留原识别结果，页面显示本期合同命中数。
- 报单表与工资表同属分析专用数据源，不进入财务报表导航，也不开放整表浏览或导出；上传记录和数据库管理仍保留版本、状态、撤回及追溯能力。
- 应用 JSON 请求体上限由 20 MB 调整为 64 MB，可容纳用户提供的约 23.2 MB Excel 经 Base64 编码后的上传请求；生产入口 `client_max_body_size 80m` 无需调整。部署前须用原始样本完成上传、发布与主营业务命中抽查，且不得把测试批次写入生产数据库。

## 31. 广州序时账动态列映射与分析取数候选（1.1.42，待部署）

- 序时账字段改为按表头动态定位，兼容旧式“借方金额/贷方金额”和广州新版“借方本币/贷方本币”，主营业务、费用分析、财务费用、序时账展示、报表下钻、往来校验与顾问投入产出共用同一映射。
- 主营业务在缺少项目名称列时不再回退到固定第 16 列，避免把部门名称显示为项目；同一凭证只有一个合同号时，摘要漏写合同号的成本分录可继承归集，多合同凭证仍保持未识别以防误配。
- 财务费用只将“财务费用-手续费”科目计入手续费并保留负数冲减；同日同凭证只有一种收款方式时自动匹配到银行转账、通联扫码、富友或财付通，否则按自身摘要分类。
- 本地 `3190` 演示数据已通过不可变上传批次补齐广州 2026-06、2026-07 的资产负债表、利润表、现金流量表、科目余额表和序时账；更新前数据库快照保存在 `data/backups/pre-1.1.42-20260903-1900`。生产仍运行既有版本，本候选尚未部署。
- 完整自动化回归 `98/98`、语法检查和部署配置检查通过。发布包为 `artifacts/wecom-finance-report-board-1.1.42.zip`，SHA256 为 `C93AA00219229A41CA963265A19E1B819C9B20A5471350FA29A5850DB7B6A081`；包内 `package.json`、`app.mjs` 与 `public/index.html` 均为 `1.1.42`。

## 32. 广州取数与往来校验合并候选（1.1.44，待部署）

- 在 `1.1.43` 往来校验概览精简与经营公司动态扩展基础上合并广州动态序时账列映射。经营公司按“桉侨/侨桉”品牌且按地区去重，普通测试公司和同地区调整账套不会误扩组合，新地区桉侨公司仍可自动加入。
- 完整自动化回归 `98/98`、语法检查和部署配置检查通过。发布包为 `artifacts/wecom-finance-report-board-1.1.44.zip`，SHA256 为 `3B0D9A0DE1A99E3137019DF9E7A50968D3165D26821E0BC0D140F972F8717876`；包内源码、服务端和 UI 版本均为 `1.1.44`。

## 33. 资产负债分析交互与可读性合并候选（1.1.45，待部署）

- 资产负债分析左右区域重新分配宽度并保持等高：左侧表格适度加宽，项目、金额、表头和汇总字号及行高同步放大；右侧图表继续占主要空间，环形图圆心金额、直接项目标签和占比字号同步提高。
- 点击表格、图表色块或直接标签后仍保留色块放大、其余色块弱化和圆心金额联动；Chromium 对可聚焦 SVG 色块绘制的黑色矩形焦点框已关闭，键盘聚焦继续使用色块加粗与柔和阴影反馈，不移除键盘访问能力。
- 桌面 `1280×720` 实测左侧约 `405px`、右侧约 `752px`，两侧高度均约 `563px`，弹窗无横向溢出；来源和去向页签、鼠标点击、键盘 Enter 及直接标签展示均已验收。
- 完整自动化回归 `98/98`、语法检查、部署配置检查和 `git diff --check` 通过。发布包为 `artifacts/wecom-finance-report-board-1.1.45.zip`，SHA256 为 `C108695403522ABE9CA3388B48E909BFD2491038625628438DE65DB90F371289`；包内版本为 `1.1.45`，包含资产负债分析样式与测试、顾问自动同步脚本和 systemd path 单元。

## 34. 生产原生依赖构建加固（1.1.46，待部署）

- `better-sqlite3` 无可用预编译包时，Docker 依赖阶段直接使用官方 Node 基础镜像自带的 `/usr/local` 头文件编译，不再访问 `nodejs.org` 下载同版本头文件；Debian 与 npm 镜像参数继续可按生产区域覆盖。
- 本版本完整包含 `1.1.45` 的资产负债分析焦点态与表图可读性改动；生产切换前必须重新通过服务器测试目标构建、正式镜像构建和数据库完整性检查。

## 35. 顾问投流消耗费用候选（1.1.47，待部署）

- 上传页新增集团分析专用数据源“顾问消耗-营收表”。系统只读取“汇总”工作表，通过表头语义动态定位顾问英文名和“总消耗/元”，不依赖固定行列；文件名中的两位年份（如“26年7月”）可自动识别为 `2026-07`。
- 顾问投入产出明细在“人员费用”右侧新增“投流消耗费用”。该列与基本工资、提成、人员费用一样可通过投入标签整列显示或隐藏，并同步参与投入合计、投入产出比、平均值、表头漏斗筛选、排序及当前视图导出。
- 投流费用只按企业微信通讯录英文名唯一匹配，忽略大小写、空格和常见标点；市场部/渠道部公共行、汇总行、重名与未匹配行不猜配，来源区会列示未匹配行数和金额。原表与工资表同属敏感分析数据源，通用原表、汇总、明细、版本和导出接口继续返回 `403`。
- 用户样表“26年7月顾问消耗-营收表.xlsx”本地隔离验收识别“汇总”表 29 名顾问，个人投流消耗合计 `488,831.69` 元；排除“市场部分给渠道部”公共费用 `6,457.50` 元，与表内总额 `495,289.19` 元勾稽一致。
- 完整自动化回归 `98/98`、服务端和前端语法检查、部署配置检查及差异检查均通过。`1280×720` 浏览器中表格和容器同为 `913px`、无横向滚动；`390×844` 下整页宽度为 `375/375`，仅表格内部保留最低可读宽度滚动，控制台无警告或错误。
- 本候选完整保留 `1.1.46` 的 Docker 原生依赖构建加固、资产负债分析修复及 `1.1.45` 动态往来公司矩阵。生产仍运行 `1.1.35`；上线前须创建 SQLite 一致性备份，再依次执行测试镜像、正式镜像、Nginx、Compose、运行时隔离和公网验收。回滚只需恢复上一镜像与 Compose；本版本没有数据库结构迁移，新数据源批次可保留，旧版本不会读取。
