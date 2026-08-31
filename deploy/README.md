# 企微应用与阿里云 ECS 部署手册

本方案适用于首个生产候选版：一台 Ubuntu 或 Alibaba Cloud Linux ECS、Nginx HTTPS、Node.js 单进程、SQLite 持久目录和每日备份。SQLite 文件与上传资料只放在 `/var/lib/wecom-finance`，版本代码放在 `/opt/wecom-finance/releases`，升级不会覆盖业务数据。

## 1. 上线资料

上线前准备：

- 已备案域名 `qiandianxiaoq.com`，A 记录解析到 ECS 公网 IP `8.163.95.203`。
- HTTPS 证书及私钥。
- 企业微信 CorpID、自建应用 AgentID 和 Secret。
- 首位系统管理员的企微 userid（不是姓名或手机号）。
- ECS 运维账号；建议 Node.js 20 LTS 或更高版本。

不要把真实 Secret 写入源码、压缩包或聊天记录。真实值只保存在服务器 `/etc/wecom-finance/report-board.env`，权限为 `0640 root:wecom-finance`。

## 2. 企业微信后台

1. 在“应用管理 → 自建应用”创建“集团财务报表看板”，设置图标，并把需要在权限管理页搜索和授权的部门/员工全部纳入应用可见范围；应用只能同步这个范围内的成员。
2. 应用主页填写 `https://qiandianxiaoq.com/report/`。
3. 在网页授权及 JS-SDK 域名中填写 `qiandianxiaoq.com`（不带协议和路径）；如后台要求域名校验，将 `WW_verify_*.txt` 放到服务器 `/var/www/wecom-verification/`。
4. 把 ECS 固定公网 IP 加入应用的企业可信 IP，供服务端调用身份与通讯录接口；同时确认应用 Secret 具备读取其可见范围通讯录的权限。
5. 记录 CorpID、AgentID 和应用 Secret，填入服务器环境文件。

OAuth 回调固定为 `https://qiandianxiaoq.com/report/auth/wecom/callback`。可信域名仍只填写主机名，不包含 `/report` 路径。管理员首次打开权限管理页时会同步应用可见范围内的通讯录，之后五分钟内复用缓存，也可在页面手动刷新；同步进来的新员工默认没有任何公司或报表权限，再由首位管理员授权。

## 3. 阿里云基础设置

- 安全组只开放 `80/443`；`22` 仅对白名单运维 IP 开放。不要开放应用端口 `3180`。
- 建议系统盘外再挂一块数据盘并把 `/var/lib/wecom-finance` 放在数据盘；同时配置阿里云磁盘快照。
- 安装 Node.js 20 LTS 或更高版本，然后把发布 ZIP 上传到服务器。初始化脚本会先复用现有 Nginx、SQLite、curl 和 Python，仅在组件确实缺失时才识别 `apt-get` 或 `dnf` 安装；真实配置完成前不会启动应用、启用备份或激活 Nginx 模板。

首次准备：

```bash
sudo bash deploy/prepare-ecs.sh
sudoedit /etc/wecom-finance/report-board.env
sudoedit /etc/wecom-finance/wecom-finance.nginx.conf
```

生产环境文件必须保留 `WECOM_DIRECTORY_SYNC_ENABLED=1`。该开关是通讯录同步的显式授权；缺少或关闭时，权限管理页会阻止同步并显示“尚未授权启用”。

将 Nginx 模板里的域名和证书路径替换为真实值。证书文件已经存在并通过核对后，按系统实际 Nginx 布局安装配置；不要提前把引用不存在证书的模板放进活动配置目录：

```bash
# Ubuntu / Debian
sudo install -o root -g root -m 0644 /etc/wecom-finance/wecom-finance.nginx.conf /etc/nginx/sites-available/wecom-finance.conf
sudo ln -s /etc/nginx/sites-available/wecom-finance.conf /etc/nginx/sites-enabled/wecom-finance.conf

# Alibaba Cloud Linux / RHEL 系；与上一组命令二选一
sudo install -o root -g root -m 0644 /etc/wecom-finance/wecom-finance.nginx.conf /etc/nginx/conf.d/wecom-finance.conf

sudo nginx -t
sudo systemctl reload nginx
```

## 4. 构建和发布

在 Windows 项目目录构建不含数据库、上传文件和 `node_modules` 的版本包：

```powershell
npm run check
npm test
npm run check:deploy
npm run build:release
```

把 `artifacts/wecom-finance-report-board-<版本>.zip` 上传到 ECS 后执行：

```bash
sudo bash deploy/deploy-release.sh /tmp/wecom-finance-report-board-<版本>.zip
```

发布脚本会安装生产依赖、校验真实环境变量、切换 `current` 软链接、重启服务并请求本机健康检查；健康检查通过后才启用开机启动和每日备份，失败时自动切回上一版本，首次发布失败则停止服务。

## 5. 验收

```bash
curl --fail http://127.0.0.1:3180/api/health
sudo systemctl status wecom-finance-report-board.service
sudo journalctl -u wecom-finance-report-board.service -n 100 --no-pager
sudo systemctl start wecom-finance-backup.service
sudo systemctl list-timers wecom-finance-backup.timer
```

随后从企业微信工作台进入应用，确认：首位管理员身份正确；普通未授权员工不显示公司卡片；公司、期间与报表权限生效；上传、预览、发布、撤回和审计日志正常；PC 和手机企微均可访问。

如需在不输出应用 Secret 或访问令牌的前提下检查通讯录可见范围，可在服务器执行：

```bash
sudo CHECK_NAME='待核对姓名' node /opt/wecom-finance/current/deploy/check-wecom-directory.mjs /etc/wecom-finance/report-board.env
```

输出仅包含可见部门数、员工数以及指定姓名是否命中，不输出内部人员标识或凭证。

## 6. 回滚与恢复

版本回滚只切换软链接，不覆盖数据：

```bash
sudo ln -sfn /opt/wecom-finance/releases/<上一版本目录> /opt/wecom-finance/current
sudo systemctl restart wecom-finance-report-board.service
```

恢复数据库前先停止服务，把目标备份复制为一个新文件并核对权限，再修改 `DB_FILE` 指向该文件后启动；不要直接覆盖正在使用的数据库。上传目录需要与数据库备份采用相同时间点的磁盘快照。

## 7. 扩容边界

当前 SQLite + 本地上传目录只允许单实例运行。需要多实例、高可用或自动伸缩时，先迁移到 PostgreSQL/RDS 和 OSS，再启用负载均衡；不得让两台 ECS 同时写同一个 SQLite 文件。
