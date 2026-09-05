# 生产部署

正式环境采用独立 Docker Compose 部署，不再使用旧财务自建应用、独立企微 OAuth 或 systemd 服务。

- 源码：`/data/repos/wecom-finance-report-board`
- 编排：`/data/opt/wecom-finance-report-board/compose.yml`
- 环境变量：`/data/secrets/wecom-finance-report-board/report-board.env`
- 持久数据：`/data/data/wecom-finance-report-board`
- 容器：`wecom-finance-report-board`
- 当前生产镜像：`aqllm/finance-report-board:1.1.69`（生产验收与回滚信息见 `docs/PRODUCTION_OPERATIONS.md`）
- 当前源码版本：`1.1.69`（恢复财务简报费用与净利润说明常驻展示）
- 本机端口：`127.0.0.1:3180`
- 正式地址：`https://anqiaoyiminxq.com/platform/finance/`

异机备份使用 `offsite-backup.sh` 和 `systemd/wecom-finance-offsite-backup.*`，由新服务器每 8 小时推送到旧服务器；旧服务器的 90 天保留策略使用 `offsite-retention.sh` 和 `systemd/wecom-finance-offsite-retention.*`。这组单元与旧服务器原有 `wecom-finance-backup.timer` 完全独立。

财务模块只以无正文 GET 请求调用小Q的 `/api/auth/me`、`/api/data-dist/my-roles` 和管理员目录同步所需的 `/api/data-dist/user-groups`。生产环境不保存企微应用 Secret，也不把报表、工资、上传文件或解析结果发送给小Q。

顾问英文名、所属公司和离职状态不经小Q接口传递。工资表或营收统计表发布后，财务容器先从已发布工资表写入只含顾问姓名的 `consultant-directory-input.json`，再写入不含人员、文件名和金额的刷新请求。宿主机 `deploy/systemd/wecom-finance-consultant-directory.service/.path/.timer` 仅使用财务专用 `/opt/wecom-finance/wecom-cli/node_modules/.bin/wecom-cli` 和独立凭证目录 `/var/lib/wecom-finance-cli`；同步器不加载 `better-sqlite3`、不打开财务数据库、不引用其他项目目录。`.path` 立即启动同步器，`.timer` 每小时兜底并检查授权。同步器只把姓名、英文名、所属公司、在职/离职状态和离职日期写入 `consultant-directory.json`，另把不含人员信息的执行结果写入 `consultant-directory-status.json`；三个 JSON 文件最终固定为 `20117:20117`、`0600`。

同步器使用 CLI 1.2.0 的 `sheet get --json` 和 `sheet ranges get --json` 结构化接口，在“在职”“离职”工作表精确读取 `D:F`（所属公司、姓名、英文名），并对“离职”表另行精确读取 `B:B`（离职日期）；两段数据只按相同行号合并，禁止读取 `C` 列离职原因。全空行可跳过。单次响应起始列、有效宽度、表头或行对齐异常时会丢弃整次响应并以完全相同的窄范围请求有限重试，连续 3 次异常才报错，且始终不覆盖安全快照。结构诊断只记录起始列、最大宽度和尝试次数，不含单元格值。不得增加扩大读取范围的开关。授权约 7 天失效后，小时级目录同步会写入 `consultant-directory-auth-request.json`，由新增 `wecom-finance-consultant-auth.path/.service` 生成 15 分钟临时授权链接；链接只通过管理员接口展示。管理员确认后授权服务自动复检并提交刷新请求。

`1.1.64` 将脱敏目录升级为 schema 3，离职日期字段统一为 `exitDate`，并兼容读取 schema 1/2 的旧 `departureDate`。同步器同时支持企业微信在线表格实际返回的 `cell_value.time.year/month/day`，规范化后再进入日期白名单。运行中的旧快照不会被直接扩大或改写；应用只提交一次 `directory_schema_upgrade` 刷新请求，由现有财务专用 `systemd.path` 触发同范围同步。生产切换前必须先执行同步脚本纯 import 和手工同步，确认 schema 3、字段白名单、`0600` 与 `20117:20117` 后，才允许切换容器。

页面滚动统一由文档主滚动区承担：顶部栏固定且层级最高，侧栏从其实际高度下方开始；表格表头随表格自然滚动，避免进入顶部品牌区。桌面与移动端都只允许具体宽表容器横向滚动，不允许整页横向溢出。

首次启用或更换源码目录后，先在候选运行镜像中挂载财务数据卷并执行 `node /app/deploy/prepare-consultant-directory-input.mjs`；该容器内工具以只读方式打开 SQLite，只在数据卷写入最小顾问匹配清单。随后宿主机可直接执行目录同步脚本的纯启动/import 预检，整个宿主机服务没有 npm 原生依赖。

顾问名单显示范围由 `app_settings.consultant_roi_hidden_consultants` 保存，只有拥有权限管理能力的管理员可以通过顾问模块修改。过滤在服务端完成，普通用户响应不含被隐藏人员或配置候选；当前顾问模块不显示导出按钮。

顾问模块把原“人员费用”统一展示为“报销费用”。后端只为权限管理员返回当前期间、唯一匹配到可见顾问的销售/管理费用二级科目候选，并继续排除工资、薪酬、提成和结转分录；普通员工不接收候选名称、金额或笔数。投入项目与报销科目按期间保存在 `app_settings`，管理员明确保存后全员使用同一口径；新期间未配置时默认计入基本工资、报销费用和投流消耗费用，提成默认不计入，报销科目默认全选。保存项在重传后不存在时忽略并提示，不自动纳入新出现科目。

上传结构模型辅助复用同服务器 AQLLM 的智谱兼容接口与项目专用 Key，并使用经生产脱敏探针验证的 `glm-4-flash`，但不让财务容器读取整份共享 `LLM.env`。启用时由服务器管理员在不打印密钥的前提下，把统一配置中的接口地址、模型和 API Key 以 `UPLOAD_MAPPING_LLM_*` 四个项目专用变量写入 `/data/secrets/wecom-finance-report-board/report-board.env`，并设置 `UPLOAD_MAPPING_LLM_ENABLED=true`；该文件继续保持 `root` 专用权限。模型只接收字段结构白名单，不接收金额、客户、项目内容或原始文件。模型失败不会阻断上传，采纳结果仍须通过服务端字段和坐标校验。

`1.1.67` 新增分公司“营收趋势分析”。服务端只从已发布的集团营收统计原文件动态重解析总营收明细，按月份字段或报价/签约/合同日期筛选当前上传期间，再按业绩归属隔离分公司数据；接口只返回聚合结果，不返回其他地区原始记录。管理员配置的数据标签组合保存在财务服务自身 `app_settings`，对所有分公司和员工统一生效，不写入 AQLLM 或共享数据库。

`1.1.68` 将口径、辅助说明和数据来源按身份统一收纳。普通授权人员只保留操作、数据结果与必要状态；权限管理员通过页面标题、板块标题或指标名称旁的问号查看完整说明。帮助浮层使用固定门户层并自动上下翻转、左右限位，支持鼠标、键盘和触屏，不改变任何报表口径、接口返回或权限模型。

`1.1.69` 恢复财务数据简报中销售费用、管理费用、财务费用和净利润的原始说明常驻展示，管理员和普通授权人员看到一致的三列原版排版；其他页面继续沿用 `1.1.68` 的身份说明收纳规则。

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
