# 桉侨财务模块生产说明

更新日期：2026-09-03
当前生产版本：1.1.25
最近发布包：1.1.25（已部署）
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
- 当前镜像：`aqllm/finance-report-board:1.1.25`
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

## 17. 资产负债分析与财务简报合并候选（1.1.27，待部署）

- 完整包含 `1.1.26` 的财务简报纯文字复制、二级备注及独立授权能力。
- 资产负债表右上方新增“资产负债分析”按钮；弹窗展示资金规模、来源/去向项目数、勾稽差额，以及两张二维环形构成图和金额/占比图例。
- 分析接口复用资产负债表汇总查看权限，每次直接读取所选公司、期间的当前已发布上传批次，响应禁止缓存；弹窗打开、手动刷新及保持打开每 60 秒均重新校验发布批次。
- 映射器按分析标题、项目/金额表头和合计行定位，不绑定固定行列；保留原项目名称、金额、源表行列和稳定分类键，未知新增项目不会静默丢失，缺表、缺合计或两侧差额会明确提示。
- 最终发布包：`artifacts/deploy-1.1.27/wecom-finance-report-board-1.1.27.zip`；SHA256：`7AC2DB763F697BA3AE3F6DB8F0D624DCE2A2E344D4E172D09B0532F5B8A2B8E5`。本地完整回归 `89/89`，真实浏览器桌面与手机端验收通过。Docker 依赖阶段提供仅构建时使用的 Python、make 和 g++，确保 `better-sqlite3` 在预编译包不可用时仍可可靠构建，最终运行镜像不包含这些工具；Debian 与安全仓库支持构建参数覆盖，阿里云生产机使用就近镜像源。
- 部署完成后在本节补充最终提交、发布包哈希、镜像、备份、生产测试与健康验收结果；部署前生产继续保持 `1.1.25`。
