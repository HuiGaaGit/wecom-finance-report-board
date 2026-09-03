#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import XLSX from 'xlsx';

let Database;
try {
  ({ default: Database } = await import('better-sqlite3')); const probe = new Database(':memory:'); probe.close();
} catch {
  const fallback = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '14云端企微账簿', 'node_modules', 'better-sqlite3', 'lib', 'index.js');
  ({ default: Database } = await import(pathToFileURL(fallback).href));
}

process.umask(0o077);
const args = process.argv.slice(2);
const valueFor = (name, fallback = '') => { const index = args.indexOf(name); return index >= 0 ? String(args[index + 1] || '') : fallback; };
const has = name => args.includes(name);
const dbFile = valueFor('--db', process.env.DB_FILE || '/data/data/wecom-finance-report-board/report-board.db');
const dataDirectory = valueFor('--data-dir', process.env.FINANCE_DATA_DIR || path.dirname(dbFile));
const outputFile = valueFor('--output', process.env.CONSULTANT_DIRECTORY_FILE || path.join(dataDirectory, 'consultant-directory.json'));
const statusFile = valueFor('--status', process.env.CONSULTANT_DIRECTORY_STATUS_FILE || path.join(dataDirectory, 'consultant-directory-status.json'));
const requestFile = valueFor('--request', process.env.CONSULTANT_DIRECTORY_REFRESH_REQUEST_FILE || path.join(dataDirectory, 'consultant-directory-refresh-request.json'));
const rosterUrl = valueFor('--roster-url', process.env.WECOM_ROSTER_URL || '');
const allowWideRead = has('--allow-wide-roster-read') || process.env.WECOM_ALLOW_WIDE_ROSTER_READ === '1';
const appUid = Number(valueFor('--uid', process.env.FINANCE_APP_UID || '20117')); const appGid = Number(valueFor('--gid', process.env.FINANCE_APP_GID || '20117'));
const configuredWecomCli = valueFor('--wecom-cli', process.env.WECOM_CLI || '');
const windowsCliScript = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@wecom', 'cli', 'bin', 'wecom.js');
const wecomCli = configuredWecomCli || (process.platform === 'win32' && fs.existsSync(windowsCliScript) ? process.execPath : 'wecom-cli');
const wecomCliPrefix = !configuredWecomCli && process.platform === 'win32' && fs.existsSync(windowsCliScript) ? [windowsCliScript] : [];

class SyncError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (message, code = 'SYNC_FAILED') => { throw new SyncError(code, message); };
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
const csvRows = content => {
  const workbook = XLSX.read(String(content || ''), { type: 'string', raw: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
};
const resolveStoredPath = stored => {
  const source = String(stored || ''); if (fs.existsSync(source)) return source;
  const prefix = '/var/lib/wecom-finance/';
  return source.startsWith(prefix) ? path.join(dataDirectory, source.slice(prefix.length)) : source;
};
const consultantNamesFromPayroll = () => {
  if (!fs.existsSync(dbFile)) fail('未找到财务数据库，无法限定顾问名单', 'SOURCE_DATA_REQUIRED');
  const database = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const uploads = database.prepare("SELECT raw_path FROM upload_batches WHERE report_type = 'payroll_statement' AND status = 'published' ORDER BY published_at DESC").all();
    const names = new Map();
    for (const upload of uploads) {
      const rawPath = resolveStoredPath(upload.raw_path); if (!rawPath || !fs.existsSync(rawPath)) continue;
      try {
        const payload = JSON.parse(fs.readFileSync(rawPath, 'utf8')); const report = payload.payroll_statement || payload.uploaded?.payroll_statement || payload;
        for (const row of report.payrollRows || []) if (/顾问/.test(String(row.department || '').replace(/\s+/g, ''))) names.set(row.canonicalName || canonicalName(row.name), String(row.name || '').trim());
      } catch {}
    }
    if (!names.size) fail('已发布工资表中尚未识别到顾问部门人员', 'SOURCE_DATA_REQUIRED');
    return names;
  } finally { database.close(); }
};
const rosterDocument = () => {
  if (rosterUrl) return { url: rosterUrl, doc_name: '花名册' };
  const result = cliJson(['doc', 'search', '--json', JSON.stringify({ keywords: ['花名册'], search_scope: 'title', doc_types: ['sheet'], sort_by: 'modify_time', limit: 10 })]);
  const exact = (result.docs || []).filter(item => item.doc_name === '花名册' && item.doc_type === 'sheet');
  if (exact.length !== 1) fail(`需要唯一的企业微信在线表格“花名册”，当前识别到 ${exact.length} 个`, exact.length ? 'ROSTER_AMBIGUOUS' : 'ROSTER_NOT_FOUND');
  return exact[0];
};
const rosterPeople = (doc, title, status) => {
  const info = cliJson(['sheet', 'info', '--docid', doc.url]); const sheet = (info.sheets || []).find(item => item.title === title);
  if (!sheet) fail(`花名册中未找到“${title}”工作表`, 'ROSTER_SHEET_MISSING');
  const result = cliJson(['sheet', 'ranges', 'get', '--docid', doc.url, '--sheet-id', sheet.sheet_id, '--range', `E1:F${Math.max(2, Number(sheet.row_count || 200))}`]);
  const rows = csvRows(result.content); const header = rows[0] || [];
  let nameIndex = header.findIndex(value => String(value).trim() === '姓名'); let englishIndex = header.findIndex(value => String(value).trim() === '英文名');
  const wide = header.length > 2;
  if (wide && !allowWideRead) fail('企业微信当前返回了超出姓名/英文名允许列的内容；为避免扩大花名册暴露面，已拒绝生成快照', 'SOURCE_SCOPE_REQUIRED');
  if (nameIndex < 0 || englishIndex < 0) fail(`“${title}”工作表未识别到姓名和英文名字段`, 'ROSTER_FIELDS_MISSING');
  const people = new Map();
  for (const row of rows.slice(1)) {
    const name = String(row[nameIndex] || '').trim(); const key = canonicalName(name); if (!key) continue;
    people.set(key, { name, englishName: safeEnglishName(row[englishIndex]), employmentStatus: status });
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
  privateJson(statusFile, statusPayload('running', '正在读取企业微信花名册与通讯录', '', { lastSuccessAt: String(priorStatus.lastSuccessAt || '') }));
  const auth = spawnSync(wecomCli, [...wecomCliPrefix, 'auth', 'show', '--status'], { encoding: 'utf8', windowsHide: true });
  if (auth.error || auth.status !== 0 || String(auth.stdout || '').trim() !== 'authorized') fail('企业微信授权未完成或已失效', 'AUTH_REQUIRED');
  const consultantNames = consultantNamesFromPayroll(); const doc = rosterDocument();
  const active = rosterPeople(doc, '在职', 'active'); const resigned = rosterPeople(doc, '离职', 'resigned'); const contactNames = contactEnglishNames(consultantNames);
  const people = [...consultantNames].map(([key, name]) => {
    const roster = resigned.get(key) || active.get(key);
    return { name, englishName: contactNames.get(key) || roster?.englishName || '', employmentStatus: resigned.has(key) ? 'resigned' : 'active' };
  }).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  const generatedAt = new Date().toISOString(); const payload = { schemaVersion: 1, generatedAt, source: { roster: '企业微信在线表格·花名册', contacts: '企业微信通讯录' }, people };
  privateJson(outputFile, payload);
  privateJson(statusFile, statusPayload('success', '企业微信花名册与通讯录已完成匹配', '', { lastSuccessAt: generatedAt, matchedPeople: people.length, englishNames: people.filter(item => item.englishName).length, resignedPeople: people.filter(item => item.employmentStatus === 'resigned').length }));
  try { fs.unlinkSync(requestFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  process.stdout.write(`顾问人事快照已更新：${people.length} 人，英文名 ${people.filter(item => item.englishName).length} 人，离职 ${people.filter(item => item.employmentStatus === 'resigned').length} 人。\n`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    const guide = {
      AUTH_REQUIRED: ['auth_required', '需要管理员重新授权企业微信', '运行 wecom-cli auth init 完成授权后重试'],
      SOURCE_SCOPE_REQUIRED: ['source_scope_required', '花名册返回范围超出允许字段，已停止读取', '建立仅含姓名和英文名的受控同步表，或由管理员确认连接器列范围'],
      SOURCE_DATA_REQUIRED: ['source_data_required', '尚无可匹配的已发布顾问工资数据', '先上传并发布含顾问部门和姓名的每月工资表'],
      ROSTER_NOT_FOUND: ['source_permission_required', '未找到企业微信在线表格“花名册”', '确认文档名称，并向同步账号授予查看权限'],
      ROSTER_AMBIGUOUS: ['source_permission_required', '找到多个同名“花名册”，无法安全选择', '配置唯一花名册链接 WECOM_ROSTER_URL 后重试'],
      ROSTER_SHEET_MISSING: ['source_permission_required', '花名册缺少“在职”或“离职”工作表', '检查工作表名称及同步账号权限'],
      ROSTER_FIELDS_MISSING: ['source_permission_required', '花名册未识别到姓名和英文名字段', '检查表头名称和字段位置后重试'],
      WECOM_PERMISSION_OR_CONNECTION: ['source_permission_required', '企业微信读取失败', '检查文档授权、通讯录权限与服务器网络后重试']
    };
    const [state, message, action] = guide[error.code] || ['error', '企业微信人事匹配刷新失败', '检查同步服务日志与企业微信连接状态后重试'];
    try {
      let priorStatus = {}; try { priorStatus = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch {}
      privateJson(statusFile, statusPayload(state, message, action, { lastSuccessAt: String(priorStatus.lastSuccessAt || '') }));
    } catch {}
    try { fs.unlinkSync(requestFile); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') process.stderr.write('顾问人事刷新请求清理失败\n'); }
    process.stderr.write(`顾问人事快照同步失败：${error.message}\n`); process.exitCode = 1;
  }
}
