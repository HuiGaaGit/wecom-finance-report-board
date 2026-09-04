# 生产部署

正式环境采用独立 Docker Compose 部署，不再使用旧财务自建应用、独立企微 OAuth 或 systemd 服务。

- 源码：`/data/repos/wecom-finance-report-board`
- 编排：`/data/opt/wecom-finance-report-board/compose.yml`
- 环境变量：`/data/secrets/wecom-finance-report-board/report-board.env`
- 持久数据：`/data/data/wecom-finance-report-board`
- 容器：`wecom-finance-report-board`
- 当前生产镜像：`aqllm/finance-report-board:1.1.49`（生产验收与回滚信息见 `docs/PRODUCTION_OPERATIONS.md`）
- 当前源码版本：`1.1.53`（管理员顾问名单显示设置与工具栏布局优化候选）
- 本机端口：`127.0.0.1:3180`
- 正式地址：`https://anqiaoyiminxq.com/platform/finance/`

异机备份使用 `offsite-backup.sh` 和 `systemd/wecom-finance-offsite-backup.*`，由新服务器每 8 小时推送到旧服务器；旧服务器的 90 天保留策略使用 `offsite-retention.sh` 和 `systemd/wecom-finance-offsite-retention.*`。这组单元与旧服务器原有 `wecom-finance-backup.timer` 完全独立。

财务模块只以无正文 GET 请求调用小Q的 `/api/auth/me`、`/api/data-dist/my-roles` 和管理员目录同步所需的 `/api/data-dist/user-groups`。生产环境不保存企微应用 Secret，也不把报表、工资、上传文件或解析结果发送给小Q。

顾问英文名和离职状态不经小Q接口传递。工资表或营收统计表发布后，财务容器先从已发布工资表写入只含顾问姓名的 `consultant-directory-input.json`，再写入不含人员、文件名和金额的刷新请求。宿主机 `deploy/systemd/wecom-finance-consultant-directory.service/.path/.timer` 仅使用财务专用 `/opt/wecom-finance/wecom-cli/node_modules/.bin/wecom-cli` 和独立凭证目录 `/var/lib/wecom-finance-cli`；同步器不加载 `better-sqlite3`、不打开财务数据库、不引用其他项目目录。`.path` 立即启动同步器，`.timer` 每小时兜底并检查授权。同步器只把姓名、英文名、在职/离职状态和同步时间写入 `consultant-directory.json`，另把不含人员信息的执行结果写入 `consultant-directory-status.json`；三个 JSON 文件最终固定为 `20117:20117`、`0600`。

同步器使用 CLI 1.2.0 的 `sheet get --json` 和 `sheet ranges get --json` 结构化接口，只读取花名册“在职”“离职”工作表 `E:F`；全空行可跳过。单次响应起始列不是 E 或非空行有效列宽超过 2 时会丢弃整次响应并以完全相同的 E:F 请求有限重试，连续 3 次异常才报错，且始终不覆盖安全快照。结构诊断只记录起始列、最大宽度和尝试次数，不含单元格值。不得增加扩大读取范围的开关。授权约 7 天失效后，小时级目录同步会写入 `consultant-directory-auth-request.json`，由新增 `wecom-finance-consultant-auth.path/.service` 生成 15 分钟临时授权链接；链接只通过管理员接口展示。管理员确认后授权服务自动复检并提交刷新请求。首次启用前依次手工验证目录同步和授权模拟，再执行 `systemctl enable --now wecom-finance-consultant-directory.path wecom-finance-consultant-directory.timer wecom-finance-consultant-auth.path`。

首次启用或更换源码目录后，先在候选运行镜像中挂载财务数据卷并执行 `node /app/deploy/prepare-consultant-directory-input.mjs`；该容器内工具以只读方式打开 SQLite，只在数据卷写入最小顾问匹配清单。随后宿主机可直接执行目录同步脚本的纯启动/import 预检，整个宿主机服务没有 npm 原生依赖。

顾问名单显示范围由 `app_settings.consultant_roi_hidden_consultants` 保存，只有拥有权限管理能力的管理员可以通过顾问模块修改。过滤在服务端完成，普通用户响应不含被隐藏人员或配置候选；当前顾问模块不显示导出按钮。

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
