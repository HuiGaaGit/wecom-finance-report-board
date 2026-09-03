import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const envFlag = args.indexOf('--env');
const envPath = envFlag >= 0 ? path.resolve(args[envFlag + 1] || '') : '';
const allowPlaceholders = args.includes('--allow-placeholders');
const values = { ...process.env };

if (envPath) {
  if (!fs.existsSync(envPath)) throw new Error(`环境文件不存在：${envPath}`);
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('='); if (index < 1) throw new Error(`环境文件包含无效行：${trimmed}`);
    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

const required = ['NODE_ENV', 'AUTH_MODE', 'PORT', 'APP_BASE_PATH', 'PUBLIC_BASE_URL', 'FINANCE_ALLOWED_ORIGIN', 'SESSION_SECRET', 'PLATFORM_API_BASE_URL', 'PLATFORM_LOGIN_URL', 'DB_FILE', 'UPLOADS_DIR', 'CONSULTANT_DIRECTORY_FILE', 'CONSULTANT_DIRECTORY_STATUS_FILE', 'CONSULTANT_DIRECTORY_REFRESH_REQUEST_FILE'];
const errors = required.filter(key => !values[key]).map(key => `缺少 ${key}`);
if (values.NODE_ENV !== 'production') errors.push('NODE_ENV 必须为 production');
if (values.AUTH_MODE !== 'platform') errors.push('AUTH_MODE 必须为 platform');
if (!/^https:\/\/[^/]+/i.test(values.PUBLIC_BASE_URL || '')) errors.push('PUBLIC_BASE_URL 必须是 HTTPS 地址');
if (!/^https:\/\/[^/]+/i.test(values.PLATFORM_API_BASE_URL || '')) errors.push('PLATFORM_API_BASE_URL 必须是 HTTPS 地址');
if (String(values.APP_BASE_PATH || '') !== '/platform/finance') errors.push('同源路径部署要求 APP_BASE_PATH=/platform/finance');
if (!/^https:\/\/[^/]+$/i.test(values.FINANCE_ALLOWED_ORIGIN || '')) errors.push('FINANCE_ALLOWED_ORIGIN 必须是 HTTPS Origin，不能包含路径');
if (!/^\/[A-Za-z0-9._~/-]*$/.test(values.PLATFORM_LOGIN_URL || '')) errors.push('PLATFORM_LOGIN_URL 必须是站内绝对路径');
try {
  const publicUrl = new URL(values.PUBLIC_BASE_URL || ''); const platformUrl = new URL(values.PLATFORM_API_BASE_URL || '');
  if (publicUrl.pathname.replace(/\/+$/, '') !== '/platform/finance') errors.push('PUBLIC_BASE_URL 路径必须是 /platform/finance');
  if (publicUrl.origin !== String(values.FINANCE_ALLOWED_ORIGIN || '').replace(/\/+$/, '')) errors.push('FINANCE_ALLOWED_ORIGIN 必须与 PUBLIC_BASE_URL 的 Origin 完全一致');
  if (publicUrl.origin !== platformUrl.origin) errors.push('同源路径部署要求财务页面与小Q平台使用相同 Origin');
} catch {}
if (String(values.SESSION_SECRET || '').length < 32) errors.push('SESSION_SECRET 至少 32 个字符');
if (!Number.isInteger(Number(values.PORT)) || Number(values.PORT) < 1024 || Number(values.PORT) > 65535) errors.push('PORT 必须是 1024 至 65535 的整数');
for (const key of ['DB_FILE', 'UPLOADS_DIR', 'CONSULTANT_DIRECTORY_FILE', 'CONSULTANT_DIRECTORY_STATUS_FILE', 'CONSULTANT_DIRECTORY_REFRESH_REQUEST_FILE']) if (!path.posix.isAbsolute(String(values[key] || '').replaceAll('\\', '/'))) errors.push(`${key} 必须是绝对路径`);
if (!allowPlaceholders) for (const key of required) if (/CHANGE_ME|example\.com/i.test(String(values[key] || ''))) errors.push(`${key} 仍是模板占位值`);

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).version;
const appSource = fs.readFileSync(path.join(projectDir, 'app.mjs'), 'utf8');
const frontendSource = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
const releaseScript = fs.readFileSync(path.join(projectDir, 'deploy', 'deploy-release.sh'), 'utf8');
const dockerfile = fs.readFileSync(path.join(projectDir, 'Dockerfile'), 'utf8');
const composeSource = fs.readFileSync(path.join(projectDir, 'deploy', 'compose.production.yml'), 'utf8');
const platformNginx = fs.readFileSync(path.join(projectDir, 'deploy', 'nginx', 'platform-finance.conf'), 'utf8');
const icpNumber = '粤ICP备2022138475号-5';
const icpUrl = 'https://beian.miit.gov.cn/';
if (!appSource.includes(`const appVersion = '${packageVersion}'`)) errors.push('app.mjs 版本与 package.json 不一致');
if (!htmlSource.includes(`v${packageVersion}`)) errors.push('UI 版本与 package.json 不一致');
if (!htmlSource.includes(icpNumber)) errors.push(`UI 缺少备案号 ${icpNumber}`);
if (!htmlSource.includes(`href="${icpUrl}"`)) errors.push('UI 备案号未链接工信部备案查询平台');
if (!appSource.includes('process.umask(0o077)')) errors.push('应用未设置私有文件 umask 077');
if (!appSource.includes("new Set(['/auth/me', '/data-dist/my-roles', '/data-dist/user-groups'])")) errors.push('平台身份接口 GET 白名单缺失');
if (!appSource.includes('ensurePrivateDirectory(path.dirname(dbFile))')) errors.push('生产数据库父目录未执行私有权限初始化');
if (!frontendSource.includes("localStorage.getItem(platformAuthStorageKey)") || frontendSource.includes("localStorage.setItem(platformAuthStorageKey")) errors.push('同源登录必须只读取小Q短期令牌，禁止由财务页面写入小Q凭证');
if (frontendSource.includes('refreshToken')) errors.push('财务页面禁止读取、刷新或复制小Q refresh token');
if (!dockerfile.includes('APP_UID=20117') || !dockerfile.includes('USER ${APP_UID}:${APP_GID}')) errors.push('运行镜像未使用专用 UID/GID');
if (!composeSource.includes('user: "20117:20117"') || !composeSource.includes('127.0.0.1:3180:3180')) errors.push('Compose 未固定专用用户或回环端口');
if (!composeSource.includes('read_only: true') || !composeSource.includes('no-new-privileges:true')) errors.push('Compose 最小权限设置缺失');
if (!platformNginx.includes('location ^~ /platform/finance/') || !platformNginx.includes('proxy_pass http://127.0.0.1:3180/') || !platformNginx.includes('access_log off') || !platformNginx.includes('proxy_request_buffering off') || !platformNginx.includes('proxy_buffering off') || !platformNginx.includes('proxy_cache off')) errors.push('同源财务路径的反向代理、无日志或无缓冲配置缺失');
if (!platformNginx.includes('deny 127.0.0.1') || !platformNginx.includes('deny 8.163.36.95') || !platformNginx.includes('deny 172.16.0.0/12')) errors.push('同源财务路径未拒绝回环、同机公网地址或 Docker 私网服务端访问');
if (!platformNginx.includes("worker-src 'none'") || !platformNginx.includes('Cross-Origin-Opener-Policy') || !platformNginx.includes('X-Frame-Options "DENY"')) errors.push('同源财务路径的浏览器安全响应头缺失');
for (const file of ['harden-finance-data.sh', 'restore-legacy-data-owner.sh', 'check-runtime-isolation.mjs']) if (!fs.existsSync(path.join(projectDir, 'deploy', file))) errors.push(`缺少隔离脚本 deploy/${file}`);
for (const file of ['sync-consultant-directory.mjs', 'systemd/wecom-finance-consultant-directory.service', 'systemd/wecom-finance-consultant-directory.timer', 'systemd/wecom-finance-consultant-directory.path']) if (!fs.existsSync(path.join(projectDir, 'deploy', file))) errors.push(`缺少顾问人事同步文件 deploy/${file}`);
if (!releaseScript.includes('--retry-connrefused')) errors.push('发布健康检查未重试连接拒绝');

if (errors.length) {
  console.error('部署就绪检查失败：'); errors.forEach(error => console.error(`- ${error}`)); process.exit(1);
}
console.log(`部署配置检查通过：v${packageVersion} · ${allowPlaceholders ? '模板结构' : values.PUBLIC_BASE_URL}`);
