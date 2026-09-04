#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
const args = process.argv.slice(2);
const valueFor = (name, fallback = '') => { const index = args.indexOf(name); return index >= 0 ? String(args[index + 1] || '') : fallback; };
const dataDirectory = valueFor('--data-dir', process.env.FINANCE_DATA_DIR || '/data/data/wecom-finance-report-board');
const statusFile = valueFor('--status', process.env.CONSULTANT_DIRECTORY_STATUS_FILE || path.join(dataDirectory, 'consultant-directory-status.json'));
const refreshRequestFile = valueFor('--request', process.env.CONSULTANT_DIRECTORY_REFRESH_REQUEST_FILE || path.join(dataDirectory, 'consultant-directory-refresh-request.json'));
const authRequestFile = valueFor('--auth-request', process.env.CONSULTANT_DIRECTORY_AUTH_REQUEST_FILE || path.join(dataDirectory, 'consultant-directory-auth-request.json'));
const wecomCli = valueFor('--wecom-cli', process.env.WECOM_CLI || 'wecom-cli');
const appUid = Number(valueFor('--uid', process.env.FINANCE_APP_UID || '20117')); const appGid = Number(valueFor('--gid', process.env.FINANCE_APP_GID || '20117'));
const now = () => new Date().toISOString();
const privateJson = (file, payload) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, file); fs.chmodSync(file, 0o600);
  if (process.platform !== 'win32' && Number.isInteger(appUid) && Number.isInteger(appGid)) fs.chownSync(file, appUid, appGid);
};
const priorStatus = () => { try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { return {}; } };
const isAuthorized = () => {
  const result = spawnSync(wecomCli, ['auth', 'show', '--status'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return !result.error && result.status === 0 && String(result.stdout || '').trim() === 'authorized';
};
const safeAuthUrl = value => {
  try {
    const decoded = String(value || '').replaceAll('&amp;', '&').replace(/[\u001b\[][0-9;]*m/g, ''); const url = new URL(decoded);
    if (url.protocol !== 'https:' || url.hostname !== 'work.weixin.qq.com' || url.pathname !== '/ai/qc/gen') return '';
    if (url.searchParams.get('source') !== 'wecom_cli_external' || !/^[A-Za-z0-9_-]{6,200}$/.test(url.searchParams.get('scode') || '')) return '';
    return url.toString();
  } catch { return ''; }
};
const requestDirectoryRefresh = () => privateJson(refreshRequestFile, { schemaVersion: 1, requestId: crypto.randomUUID(), requestedAt: now(), reason: 'authorization_completed' });
const completeAuthorized = () => {
  const previous = priorStatus();
  privateJson(statusFile, { schemaVersion: 1, state: 'pending', message: '企业微信授权已更新，正在刷新顾问匹配', action: '', updatedAt: now(), lastSuccessAt: String(previous.lastSuccessAt || '') });
  requestDirectoryRefresh(); try { fs.unlinkSync(authRequestFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
};

const main = async () => {
  if (isAuthorized()) { completeAuthorized(); return; }
  const previous = priorStatus(); let discoveredUrl = ''; let output = '';
  privateJson(statusFile, { schemaVersion: 1, state: 'auth_required', message: '企业微信授权已到期，正在生成重新授权链接', action: '请由财务管理员完成企业微信授权', updatedAt: now(), lastSuccessAt: String(previous.lastSuccessAt || '') });
  const child = spawn(wecomCli, ['auth', 'init', '--noninteractive'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const inspect = chunk => {
    output = `${output}${String(chunk || '')}`.slice(-64 * 1024);
    const candidates = output.match(/https:\/\/work\.weixin\.qq\.com\/ai\/qc\/gen\?[^\s"'<>]+/g) || [];
    const next = candidates.map(safeAuthUrl).find(Boolean) || '';
    if (!next || next === discoveredUrl) return;
    discoveredUrl = next; const updatedAt = now(); const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    privateJson(statusFile, { schemaVersion: 1, state: 'auth_required', message: '企业微信授权已到期，请使用临时链接重新授权', action: '点击重新授权并在企业微信中确认', updatedAt, lastSuccessAt: String(previous.lastSuccessAt || ''), authUrl: discoveredUrl, authUrlExpiresAt: expiresAt });
  };
  child.stdout.on('data', inspect); child.stderr.on('data', inspect);
  const timeout = setTimeout(() => child.kill('SIGTERM'), 15 * 60_000);
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); clearTimeout(timeout);
  if (isAuthorized()) { completeAuthorized(); return; }
  privateJson(statusFile, { schemaVersion: 1, state: 'auth_required', message: exitCode === 0 ? '企业微信授权尚未完成' : '重新授权链接已失效或授权未完成', action: '请点击重新生成授权链接', updatedAt: now(), lastSuccessAt: String(previous.lastSuccessAt || '') });
  try { fs.unlinkSync(authRequestFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  process.exitCode = 1;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch {
    const previous = priorStatus();
    try { privateJson(statusFile, { schemaVersion: 1, state: 'error', message: '企业微信重新授权服务运行失败', action: '请管理员检查财务专用授权服务', updatedAt: now(), lastSuccessAt: String(previous.lastSuccessAt || '') }); } catch {}
    process.stderr.write('财务专用企业微信重新授权失败\n'); process.exitCode = 1;
  }
}

export { safeAuthUrl };
