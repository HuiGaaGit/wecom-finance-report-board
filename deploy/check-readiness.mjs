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

const required = ['NODE_ENV', 'AUTH_MODE', 'PORT', 'APP_BASE_PATH', 'PUBLIC_BASE_URL', 'SESSION_SECRET', 'WECOM_CORP_ID', 'WECOM_AGENT_ID', 'WECOM_SECRET', 'WECOM_BOOTSTRAP_ADMIN_USERID', 'WECOM_DIRECTORY_SYNC_ENABLED', 'DB_FILE', 'UPLOADS_DIR'];
const errors = required.filter(key => !values[key]).map(key => `缺少 ${key}`);
if (values.NODE_ENV !== 'production') errors.push('NODE_ENV 必须为 production');
if (values.AUTH_MODE !== 'wecom') errors.push('AUTH_MODE 必须为 wecom');
if (values.WECOM_DIRECTORY_SYNC_ENABLED !== '1') errors.push('WECOM_DIRECTORY_SYNC_ENABLED 必须为 1，权限页才能同步应用可见通讯录');
if (!/^https:\/\/[^/]+/i.test(values.PUBLIC_BASE_URL || '')) errors.push('PUBLIC_BASE_URL 必须是 HTTPS 地址');
if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(values.APP_BASE_PATH || '')) errors.push('APP_BASE_PATH 必须是安全的绝对路径前缀');
try {
  if (new URL(values.PUBLIC_BASE_URL || '').pathname.replace(/\/+$/, '') !== values.APP_BASE_PATH) errors.push('PUBLIC_BASE_URL 路径必须与 APP_BASE_PATH 一致');
} catch {}
if (String(values.SESSION_SECRET || '').length < 32) errors.push('SESSION_SECRET 至少 32 个字符');
if (!Number.isInteger(Number(values.PORT)) || Number(values.PORT) < 1024 || Number(values.PORT) > 65535) errors.push('PORT 必须是 1024 至 65535 的整数');
for (const key of ['DB_FILE', 'UPLOADS_DIR']) if (!path.posix.isAbsolute(String(values[key] || '').replaceAll('\\', '/'))) errors.push(`${key} 必须是绝对路径`);
if (!allowPlaceholders) for (const key of required) if (/CHANGE_ME|example\.com/i.test(String(values[key] || ''))) errors.push(`${key} 仍是模板占位值`);

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).version;
const appSource = fs.readFileSync(path.join(projectDir, 'app.mjs'), 'utf8');
const htmlSource = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
const releaseScript = fs.readFileSync(path.join(projectDir, 'deploy', 'deploy-release.sh'), 'utf8');
const icpNumber = '粤ICP备2022138475号-5';
const icpUrl = 'https://beian.miit.gov.cn/';
if (!appSource.includes(`const appVersion = '${packageVersion}'`)) errors.push('app.mjs 版本与 package.json 不一致');
if (!htmlSource.includes(`v${packageVersion}`)) errors.push('UI 版本与 package.json 不一致');
if (!htmlSource.includes(icpNumber)) errors.push(`UI 缺少备案号 ${icpNumber}`);
if (!htmlSource.includes(`href="${icpUrl}"`)) errors.push('UI 备案号未链接工信部备案查询平台');
if (!appSource.includes('fs.mkdirSync(path.dirname(dbFile), { recursive: true })')) errors.push('生产数据库父目录未按 DB_FILE 创建');
if (!releaseScript.includes('--retry-connrefused')) errors.push('发布健康检查未重试连接拒绝');

if (errors.length) {
  console.error('部署就绪检查失败：'); errors.forEach(error => console.error(`- ${error}`)); process.exit(1);
}
console.log(`部署配置检查通过：v${packageVersion} · ${allowPlaceholders ? '模板结构' : values.PUBLIC_BASE_URL}`);
