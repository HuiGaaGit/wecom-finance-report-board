#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
const args = process.argv.slice(2);
const valueFor = (name, fallback = '') => { const index = args.indexOf(name); return index >= 0 ? String(args[index + 1] || '') : fallback; };
const dataDirectory = valueFor('--data-dir', process.env.FINANCE_DATA_DIR || '/data/data/wecom-finance-report-board');
const outputFile = valueFor('--output', process.env.CONSULTANT_DIRECTORY_FILE || path.join(dataDirectory, 'consultant-directory.json'));
const statusFile = valueFor('--status', process.env.CONSULTANT_DIRECTORY_STATUS_FILE || path.join(dataDirectory, 'consultant-directory-status.json'));
const requestFile = valueFor('--request', process.env.CONSULTANT_DIRECTORY_REFRESH_REQUEST_FILE || path.join(dataDirectory, 'consultant-directory-refresh-request.json'));
const authRequestFile = valueFor('--auth-request', process.env.CONSULTANT_DIRECTORY_AUTH_REQUEST_FILE || path.join(dataDirectory, 'consultant-directory-auth-request.json'));
const inputFile = valueFor('--input', process.env.CONSULTANT_DIRECTORY_INPUT_FILE || path.join(dataDirectory, 'consultant-directory-input.json'));
const rosterUrl = valueFor('--roster-url', process.env.WECOM_ROSTER_URL || '');
const appUid = Number(valueFor('--uid', process.env.FINANCE_APP_UID || '20117')); const appGid = Number(valueFor('--gid', process.env.FINANCE_APP_GID || '20117'));
const configuredWecomCli = valueFor('--wecom-cli', process.env.WECOM_CLI || '');
const windowsCliScript = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@wecom', 'cli', 'bin', 'wecom.js');
const wecomCli = configuredWecomCli || (process.platform === 'win32' && fs.existsSync(windowsCliScript) ? process.execPath : 'wecom-cli');
const wecomCliPrefix = !configuredWecomCli && process.platform === 'win32' && fs.existsSync(windowsCliScript) ? [windowsCliScript] : [];

class SyncError extends Error { constructor(code, message, diagnostic = {}) { super(message); this.code = code; this.diagnostic = diagnostic; } }
const fail = (message, code = 'SYNC_FAILED', diagnostic = {}) => { throw new SyncError(code, message, diagnostic); };
const privateJson = (file, payload) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, file); fs.chmodSync(file, 0o600);
  if (process.platform !== 'win32' && Number.isInteger(appUid) && Number.isInteger(appGid)) fs.chownSync(file, appUid, appGid);
};
const statusPayload = (state, message, action = '', extra = {}) => ({ schemaVersion: 1, state, message, action, updatedAt: new Date().toISOString(), ...extra });
const cliJson = commandArgs => {
  const result = spawnSync(wecomCli, [...wecomCliPrefix, ...commandArgs], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (result.error) fail(`无法运行企业微信 CLI：${result.error.message}`, 'WECOM_UNAVAILABLE');
  if (result.status !== 0) fail(`企业微信 CLI 调用失败（${commandArgs.slice(0, 3).join(' ')}）`, 'WECOM_PERMISSION_OR_CONNECTION');
  try { return JSON.parse(result.stdout); } catch { fail('企业微信 CLI 返回内容不是有效 JSON', 'WECOM_INVALID_RESPONSE'); }
};
const canonicalName = value => {
  const text = String(value || '').trim().replace(/\s+/g, '');
  return text.match(/[\u4e00-\u9fa5]{2,6}/g)?.at(-1) || text.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
};
const safeEnglishName = value => String(value || '').replace(/[\u0000-\u001f\u007f\u4e00-\u9fff]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
const safeCompanyName = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
const safeRosterDate = value => {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const match = text.match(/^(20\d{2})[年/.\-](1[0-2]|0?[1-9])[月/.\-](3[01]|[12]\d|0?[1-9])日?$/);
  if (!match) return '';
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]); const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : '';
};
const documentIdFor = doc => String(doc?.docid || doc?.url || '').match(/\/sheet\/([^?/#]+)/)?.[1] || String(doc?.docid || doc?.url || '');
const gridCellText = cell => {
  const value = cell?.cell_value ?? cell?.value ?? cell;
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (value.text != null) return String(value.text).trim();
  if (value.number != null) return String(value.number).trim();
  if (value.link?.text != null) return String(value.link.text).trim();
  if (value.display_value != null) return String(value.display_value).trim();
  return '';
};
const exactColumnRows = (result, { startColumn = 4, width = 2, label = '姓名/英文名' } = {}) => {
  const sourceRows = result?.grid_data?.rows;
  if (!Array.isArray(sourceRows)) fail('企业微信表格未返回结构化区域数据', 'WECOM_INVALID_RESPONSE');
  const actualStartColumn = Number(result?.grid_data?.start_column);
  if (actualStartColumn !== startColumn) fail(`企业微信返回区域的起始列不是预期列；为避免扩大${label}暴露面，已拒绝生成快照`, 'SOURCE_SCOPE_REQUIRED', { startColumn: Number.isFinite(actualStartColumn) ? actualStartColumn : null, expectedStartColumn: startColumn, maximumWidth: 0, allowedWidth: width });
  return sourceRows.map(row => {
    const values = Array.isArray(row?.values) ? row.values : [];
    const cells = values.map(gridCellText); let effectiveWidth = cells.length;
    while (effectiveWidth && !cells[effectiveWidth - 1]) effectiveWidth -= 1;
    if (effectiveWidth > width) fail(`企业微信当前返回了超出${label}允许列的内容；为避免扩大花名册暴露面，已拒绝生成快照`, 'SOURCE_SCOPE_REQUIRED', { startColumn: actualStartColumn, expectedStartColumn: startColumn, maximumWidth: effectiveWidth, allowedWidth: width });
    return Array.from({ length: width }, (_, index) => cells[index] || '');
  });
};
const exactTwoColumnRows = result => exactColumnRows(result);
const exactRosterRows = (commandArgs, read = cliJson, pause = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds), options = {}) => {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return exactColumnRows(read(commandArgs), options); }
    catch (error) {
      if (error.code !== 'SOURCE_SCOPE_REQUIRED') throw error;
      lastError = new SyncError(error.code, error.message, { ...error.diagnostic, attempts: attempt });
      if (attempt < 3) pause(attempt * 500);
    }
  }
  throw lastError;
};
const preservedAuthLink = source => {
  try {
    const authUrl = new URL(String(source?.authUrl || '')); const authUrlExpiresAt = String(source?.authUrlExpiresAt || '');
    if (authUrl.protocol !== 'https:' || authUrl.hostname !== 'work.weixin.qq.com' || authUrl.pathname !== '/ai/qc/gen') return {};
    if (authUrl.searchParams.get('source') !== 'wecom_cli_external' || !/^[A-Za-z0-9_-]{6,200}$/.test(authUrl.searchParams.get('scode') || '')) return {};
    if (!authUrlExpiresAt || Date.parse(authUrlExpiresAt) <= Date.now()) return {};
    return { authUrl: authUrl.toString(), authUrlExpiresAt };
  } catch { return {}; }
};
const consultantNamesFromInput = (sourceFile = inputFile) => {
  try {
    const stat = fs.statSync(sourceFile); if (!stat.isFile() || stat.size <= 0 || stat.size > 256 * 1024) fail('顾问匹配清单大小异常', 'SOURCE_DATA_REQUIRED');
    const payload = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    if (payload?.schemaVersion !== 1 || !Array.isArray(payload.people) || payload.people.length > 5000) fail('顾问匹配清单格式异常', 'SOURCE_DATA_REQUIRED');
    const names = new Map();
    for (const person of payload.people) {
      if (!person || Object.keys(person).some(key => key !== 'name')) fail('顾问匹配清单包含未授权字段', 'SOURCE_SCOPE_REQUIRED');
      const name = String(person.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40); const key = canonicalName(name);
      if (name && key) names.set(key, name);
    }
    if (!names.size) fail('已发布工资表中尚未识别到顾问部门人员', 'SOURCE_DATA_REQUIRED');
    return names;
  } catch (error) {
    if (error instanceof SyncError) throw error;
    fail('未找到可用的财务顾问匹配清单', 'SOURCE_DATA_REQUIRED');
  }
};
const rosterDocument = () => {
  if (rosterUrl) return { url: rosterUrl, doc_name: '花名册' };
  const result = cliJson(['doc', 'search', '--json', JSON.stringify({ keywords: ['花名册'], search_scope: 'title', doc_types: ['sheet'], sort_by: 'modify_time', limit: 10 })]);
  const exact = (result.docs || []).filter(item => item.doc_name === '花名册' && item.doc_type === 'sheet');
  if (exact.length !== 1) fail(`需要唯一的企业微信在线表格“花名册”，当前识别到 ${exact.length} 个`, exact.length ? 'ROSTER_AMBIGUOUS' : 'ROSTER_NOT_FOUND');
  return exact[0];
};
const rosterPeople = (doc, title, status) => {
  const docid = documentIdFor(doc); const info = cliJson(['sheet', 'get', '--json', JSON.stringify({ docid })]); const sheet = (info.sheets || []).find(item => item.title === title);
  if (!sheet) fail(`花名册中未找到“${title}”工作表`, 'ROSTER_SHEET_MISSING');
  const rowCount = Math.max(2, Number(sheet.row_count || 200)); const profileRange = `D1:F${rowCount}`;
  const rows = exactRosterRows(['sheet', 'ranges', 'get', '--json', JSON.stringify({ docid, sheet_id: sheet.sheet_id, mode: 'default', range: profileRange })], cliJson, undefined, { startColumn: 3, width: 3, label: '所属公司/姓名/英文名' });
  const headerRowIndex = rows.findIndex(row => row.some(Boolean)); const header = rows[headerRowIndex] || [];
  const companyIndex = header.findIndex(value => String(value).trim() === '所属公司'); const nameIndex = header.findIndex(value => String(value).trim() === '姓名'); const englishIndex = header.findIndex(value => String(value).trim() === '英文名');
  if (companyIndex < 0 || nameIndex < 0 || englishIndex < 0) fail(`“${title}”工作表未识别到所属公司、姓名和英文名字段`, 'ROSTER_FIELDS_MISSING');
  let departureRows = [];
  if (status === 'resigned') {
    const departureRange = `B1:B${rowCount}`;
    departureRows = exactRosterRows(['sheet', 'ranges', 'get', '--json', JSON.stringify({ docid, sheet_id: sheet.sheet_id, mode: 'default', range: departureRange })], cliJson, undefined, { startColumn: 1, width: 1, label: '离职日期' });
    const departureHeaderIndex = departureRows.findIndex(row => /离职日期|last\s*day/i.test(String(row[0] || '').replace(/[（）()]/g, ' ')));
    if (departureHeaderIndex < 0 || departureHeaderIndex !== headerRowIndex) fail(`“${title}”工作表未识别到与人员行对齐的离职日期字段`, 'ROSTER_FIELDS_MISSING');
  }
  const people = new Map();
  for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const name = String(row[nameIndex] || '').trim(); const key = canonicalName(name); if (!key) continue;
    people.set(key, { name, englishName: safeEnglishName(row[englishIndex]), companyName: safeCompanyName(row[companyIndex]), employmentStatus: status, departureDate: status === 'resigned' ? safeRosterDate(departureRows[rowIndex]?.[0]) : '' });
  }
  return people;
};
const contactEnglishNames = names => {
  const entries = [...names.entries()]; const result = new Map();
  for (let index = 0; index < entries.length; index += 10) {
    const batch = entries.slice(index, index + 10); const response = cliJson(['contact', 'users', 'search', '--json', JSON.stringify({ keywords: batch.map(([, name]) => name) })]);
    for (const [key, requestedName] of batch) {
      const matches = (response.users || []).filter(user => (user.matched_keywords || []).some(keyword => canonicalName(keyword) === key) || canonicalName(user.name) === key);
      if (matches.length !== 1) continue;
      const user = matches[0]; const fromDisplayName = String(user.name || '').replace(requestedName, '');
      const englishName = safeEnglishName(user.alias) || safeEnglishName(fromDisplayName);
      if (englishName) result.set(key, englishName);
    }
  }
  return result;
};

const main = () => {
  let priorStatus = {}; try { priorStatus = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch {}
  const auth = spawnSync(wecomCli, [...wecomCliPrefix, 'auth', 'show', '--status'], { encoding: 'utf8', windowsHide: true });
  if (auth.error || auth.status !== 0 || String(auth.stdout || '').trim() !== 'authorized') fail('企业微信授权未完成或已失效', 'AUTH_REQUIRED');
  privateJson(statusFile, statusPayload('running', '正在读取企业微信花名册与通讯录', '', { lastSuccessAt: String(priorStatus.lastSuccessAt || '') }));
  const consultantNames = consultantNamesFromInput(); const doc = rosterDocument();
  const active = rosterPeople(doc, '在职', 'active'); const resigned = rosterPeople(doc, '离职', 'resigned'); const contactNames = contactEnglishNames(consultantNames);
  const people = [...consultantNames].map(([key, name]) => {
    const roster = resigned.get(key) || active.get(key);
    return { name, englishName: contactNames.get(key) || roster?.englishName || '', companyName: roster?.companyName || '', employmentStatus: resigned.has(key) ? 'resigned' : 'active', departureDate: resigned.has(key) ? roster?.departureDate || '' : '' };
  }).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  const generatedAt = new Date().toISOString(); const payload = { schemaVersion: 2, generatedAt, source: { roster: '企业微信在线表格·花名册', contacts: '企业微信通讯录' }, people };
  privateJson(outputFile, payload);
  privateJson(statusFile, statusPayload('success', '企业微信花名册与通讯录已完成匹配', '', { lastSuccessAt: generatedAt, matchedPeople: people.length, englishNames: people.filter(item => item.englishName).length, resignedPeople: people.filter(item => item.employmentStatus === 'resigned').length }));
  try { fs.unlinkSync(requestFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  process.stdout.write(`顾问人事快照已更新：${people.length} 人，英文名 ${people.filter(item => item.englishName).length} 人，离职 ${people.filter(item => item.employmentStatus === 'resigned').length} 人。\n`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    const guide = {
      AUTH_REQUIRED: ['auth_required', '需要管理员重新授权企业微信', '运行 wecom-cli auth init 完成授权后重试'],
      SOURCE_SCOPE_REQUIRED: ['source_scope_required', '花名册返回范围超出允许字段，已停止读取', '确认花名册 D:F 为所属公司、姓名、英文名，离职表 B 列为离职日期'],
      SOURCE_DATA_REQUIRED: ['source_data_required', '尚无可匹配的已发布顾问工资数据', '先上传并发布含顾问部门和姓名的每月工资表'],
      ROSTER_NOT_FOUND: ['source_permission_required', '未找到企业微信在线表格“花名册”', '确认文档名称，并向同步账号授予查看权限'],
      ROSTER_AMBIGUOUS: ['source_permission_required', '找到多个同名“花名册”，无法安全选择', '配置唯一花名册链接 WECOM_ROSTER_URL 后重试'],
      ROSTER_SHEET_MISSING: ['source_permission_required', '花名册缺少“在职”或“离职”工作表', '检查工作表名称及同步账号权限'],
      ROSTER_FIELDS_MISSING: ['source_permission_required', '花名册未识别到所属公司、姓名、英文名或离职日期字段', '确认在职/离职表 D:F 与离职表 B 列表头及行号一致'],
      WECOM_PERMISSION_OR_CONNECTION: ['source_permission_required', '企业微信读取失败', '检查文档授权、通讯录权限与服务器网络后重试']
    };
    const [state, message, action] = guide[error.code] || ['error', '企业微信人事匹配刷新失败', '检查同步服务日志与企业微信连接状态后重试'];
    try {
      let priorStatus = {}; try { priorStatus = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch {}
      privateJson(statusFile, statusPayload(state, message, action, { lastSuccessAt: String(priorStatus.lastSuccessAt || ''), ...(error.code === 'AUTH_REQUIRED' ? preservedAuthLink(priorStatus) : {}), ...(error.code === 'SOURCE_SCOPE_REQUIRED' ? { diagnostic: error.diagnostic } : {}) }));
    } catch {}
    if (error.code === 'AUTH_REQUIRED') {
      try { privateJson(authRequestFile, { schemaVersion: 1, requestId: crypto.randomUUID(), requestedAt: new Date().toISOString(), reason: 'authorization_expired' }); } catch {}
    }
    try { fs.unlinkSync(requestFile); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') process.stderr.write('顾问人事刷新请求清理失败\n'); }
    process.stderr.write(`顾问人事快照同步失败：${error.message}\n`); process.exitCode = 1;
  }
}

export { gridCellText, exactColumnRows, exactTwoColumnRows, exactRosterRows, consultantNamesFromInput, preservedAuthLink, safeRosterDate };
