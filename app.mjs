import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import {
  hasFinancePlatformAccess,
  normalizePlatformIdentity,
  parseBearerToken,
  platformDirectoryMembers,
  unwrapPlatformData,
} from './platform-auth.mjs';
import { parseAssetLiabilityAnalysis } from './asset-liability-analysis.mjs';

// 财务文件、SQLite WAL/SHM 与临时解析产物默认仅允许当前专用运行用户访问。
process.umask(0o077);
let Database;
try {
  ({ default: Database } = await import('better-sqlite3'));
  // npm 在 Node 24 Windows 上可能只有 JS 外壳而没有预编译二进制，先探测一次再回退。
  const probe = new Database(':memory:'); probe.close();
} catch {
  // 本地 Windows 演示复用工作区已验证的 better-sqlite3 二进制；线上安装依赖后优先使用包自身。
  ({ default: Database } = await import('../14云端企微账簿/node_modules/better-sqlite3/lib/index.js'));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const appVersion = '1.1.33';
const financialBriefModuleKey = 'financial_brief';
const financialBriefNotesPermissionKey = 'module.financial_brief.notes.manage';
const financialBriefMetricKeys = new Set(['expectedRevenue', 'accountBalance', 'operatingRevenue', 'operatingCost', 'sellingExpense', 'managementExpense', 'financeExpense', 'netProfit']);
const consultantRoiModuleKey = 'consultant_roi_analysis';
const intercompanyModuleKey = 'intercompany_reconciliation';
const activityLogModuleKey = 'activity_logs';
const intercompanyViewPermissionKey = `module.${intercompanyModuleKey}.view`;
const intercompanyDetailPermissionKey = `module.${intercompanyModuleKey}.detail`;
const cashNetPositionsPermissionKey = 'module.cash_analysis.net_positions.view';
const analysisBlockPermissionDefinitions = {
  cash_analysis: {
    pageName: '资产净额分析',
    blocks: {
      net_positions: '应收应付净额构成',
      cash_accounts: '货币资金账户',
      other_liquidity: '其他流动项目',
      core_liquidity_trend: '核心流动性净额月度变动'
    }
  },
  main_business_analysis: {
    pageName: '主营业务分析',
    blocks: {
      business_detail: '本期确认的项目主营业务收入成本',
      project_change: '项目数量变化',
      gross_trend: '主营业务毛利月度变动'
    }
  },
  expense_analysis: {
    pageName: '费用分析',
    blocks: {
      selling_table: '销售费用分析',
      selling_share: '销售费用本期占比',
      selling_trend: '销售费用月度变动',
      admin_table: '管理费用分析',
      admin_share: '管理费用本期占比',
      admin_trend: '管理费用月度变动',
      finance_table: '财务费用分析',
      finance_share: '本月支付方式本期占比',
      finance_methods: '财务费用月度支付方式'
    }
  }
};
const analysisBlockPermissionKey = (pageKey, blockKey) => `module.${pageKey}.${blockKey}.view`;
const analysisBlockPermissionKeys = pageKey => Object.keys(analysisBlockPermissionDefinitions[pageKey]?.blocks || {}).map(blockKey => analysisBlockPermissionKey(pageKey, blockKey));
const payrollStatementReportType = 'payroll_statement';
const revenueProfitReportType = 'revenue_profit_consolidated_income_statement';
const revenueStatisticsReportType = 'revenue_statistics';
const groupStatementReportTypes = new Set(['consolidated_income_statement', revenueProfitReportType]);
const groupOnlyReportTypes = new Set([...groupStatementReportTypes, revenueStatisticsReportType, payrollStatementReportType]);
const sourceOnlyReportTypes = new Set([payrollStatementReportType]);
const authMode = String(process.env.AUTH_MODE || (process.env.NODE_ENV === 'production' ? 'platform' : 'demo')).trim().toLowerCase();
const accessDeniedMessage = '当前账号不在财务模块授权范围内，请联系管理员加入总经理、管理员或财务组';
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const rawBasePath = String(process.env.APP_BASE_PATH || '').trim();
const appBasePath = rawBasePath && rawBasePath !== '/' ? `/${rawBasePath.replace(/^\/+|\/+$/g, '')}` : '';
if (appBasePath && !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(appBasePath)) throw new Error('APP_BASE_PATH 必须是安全的绝对路径前缀，例如 /report');
const safeNavigationUrl = value => {
  if (!value || /[\u0000-\u0020"'<>\\]/.test(value)) return false;
  if (/^\/[A-Za-z0-9._~/-]*$/.test(value)) return true;
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash; } catch { return false; }
};
const portalHomeUrl = String(process.env.PORTAL_HOME_URL || '/platform/').trim();
if (!safeNavigationUrl(portalHomeUrl)) throw new Error('PORTAL_HOME_URL 必须是安全的站内路径或 HTTPS 地址');
const platformLoginUrl = String(process.env.PLATFORM_LOGIN_URL || '/platform/login').trim();
if (!safeNavigationUrl(platformLoginUrl)) throw new Error('PLATFORM_LOGIN_URL 必须是安全的站内路径或 HTTPS 地址');
const platformApiBaseUrl = String(process.env.PLATFORM_API_BASE_URL || '').trim().replace(/\/+$/, '');
const financeAllowedOrigin = String(process.env.FINANCE_ALLOWED_ORIGIN || (() => { try { return new URL(publicBaseUrl).origin; } catch { return ''; } })()).trim().replace(/\/+$/, '');
const appPath = pathname => `${appBasePath}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
const sessionSecret = String(process.env.SESSION_SECRET || (authMode === 'demo' ? 'local-demo-session-secret' : ''));
if (!['demo', 'platform'].includes(authMode)) throw new Error('AUTH_MODE 仅支持 demo 或 platform');
if (authMode === 'platform') {
  const missing = [['PUBLIC_BASE_URL', publicBaseUrl], ['SESSION_SECRET', sessionSecret], ['PLATFORM_API_BASE_URL', platformApiBaseUrl], ['FINANCE_ALLOWED_ORIGIN', financeAllowedOrigin]].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`小Q统一认证缺少环境变量：${missing.join(', ')}`);
  if (process.env.NODE_ENV === 'production') {
    if (!/^https:\/\//i.test(publicBaseUrl)) throw new Error('小Q生产认证要求 PUBLIC_BASE_URL 使用 HTTPS');
    if (!/^https:\/\//i.test(platformApiBaseUrl)) throw new Error('小Q生产认证要求 PLATFORM_API_BASE_URL 使用 HTTPS');
    if (appBasePath !== '/platform/finance') throw new Error('同源路径部署要求 APP_BASE_PATH=/platform/finance');
    if (new URL(publicBaseUrl).origin !== new URL(platformApiBaseUrl).origin) throw new Error('同源路径部署要求财务页面与小Q平台使用相同 Origin');
  }
  if (new URL(publicBaseUrl).pathname.replace(/\/+$/, '') !== appBasePath) throw new Error('PUBLIC_BASE_URL 路径必须与 APP_BASE_PATH 一致');
  if (new URL(publicBaseUrl).origin !== financeAllowedOrigin) throw new Error('FINANCE_ALLOWED_ORIGIN 必须与 PUBLIC_BASE_URL 的 Origin 完全一致');
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET 至少需要 32 个字符');
}
const dbFile = process.env.DB_FILE || path.join(dataDir, 'report-board.db');
const ensurePrivateDirectory = directory => { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); try { fs.chmodSync(directory, 0o700); } catch (error) { if (process.platform !== 'win32') throw error; } };
ensurePrivateDirectory(path.dirname(dbFile));
const db = new Database(dbFile);
try { fs.chmodSync(dbFile, 0o600); } catch (error) { if (process.platform !== 'win32') throw error; }
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS employees (
  employee_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  department TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  directory_source TEXT NOT NULL DEFAULT 'local',
  directory_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS directory_sync_state (
  source TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  employee_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS roles (
  role_key TEXT PRIMARY KEY,
  role_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS employee_roles (
  employee_key TEXT NOT NULL,
  role_key TEXT NOT NULL,
  PRIMARY KEY (employee_key, role_key),
  FOREIGN KEY (employee_key) REFERENCES employees(employee_key),
  FOREIGN KEY (role_key) REFERENCES roles(role_key)
);
CREATE TABLE IF NOT EXISTS modules (
  module_key TEXT PRIMARY KEY,
  module_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dashboard_module_order (
  module_key TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS analysis_block_order (
  page_key TEXT NOT NULL,
  block_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (page_key, block_key)
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_key TEXT NOT NULL,
  module_key TEXT NOT NULL,
  action TEXT NOT NULL,
  PRIMARY KEY (role_key, module_key, action),
  FOREIGN KEY (role_key) REFERENCES roles(role_key),
  FOREIGN KEY (module_key) REFERENCES modules(module_key)
);
CREATE TABLE IF NOT EXISTS companies (
  company_key TEXT PRIMARY KEY,
  company_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS company_display_order (
  company_key TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  FOREIGN KEY (company_key) REFERENCES companies(company_key)
);
CREATE TABLE IF NOT EXISTS report_types (
  report_type TEXT PRIMARY KEY,
  report_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS role_report_scopes (
  role_key TEXT NOT NULL,
  report_type TEXT NOT NULL,
  access_level TEXT NOT NULL CHECK (access_level IN ('summary', 'detail')),
  action TEXT NOT NULL CHECK (action IN ('view', 'export')),
  company_key TEXT NOT NULL,
  from_period TEXT NOT NULL,
  to_period TEXT NOT NULL,
  PRIMARY KEY (role_key, report_type, access_level, action, company_key, from_period, to_period),
  FOREIGN KEY (role_key) REFERENCES roles(role_key),
  FOREIGN KEY (report_type) REFERENCES report_types(report_type)
);
CREATE TABLE IF NOT EXISTS role_account_visibility (
  role_key TEXT PRIMARY KEY,
  visibility TEXT NOT NULL CHECK (visibility IN ('level1', 'full')),
  FOREIGN KEY (role_key) REFERENCES roles(role_key)
);
CREATE TABLE IF NOT EXISTS role_detail_preferences (
  role_key TEXT PRIMARY KEY,
  show_direction INTEGER NOT NULL DEFAULT 1,
  show_full_entry INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (role_key) REFERENCES roles(role_key)
);
CREATE TABLE IF NOT EXISTS employee_permission_profiles (
  employee_key TEXT PRIMARY KEY,
  preset_role_key TEXT NOT NULL,
  permission_keys_json TEXT NOT NULL,
  company_keys_json TEXT NOT NULL,
  from_period TEXT NOT NULL,
  to_period TEXT NOT NULL,
  account_visibility TEXT NOT NULL CHECK (account_visibility IN ('level1', 'full')),
  show_direction INTEGER NOT NULL DEFAULT 1,
  show_full_entry INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (employee_key) REFERENCES employees(employee_key),
  FOREIGN KEY (preset_role_key) REFERENCES roles(role_key)
);
CREATE TABLE IF NOT EXISTS financial_brief_notes (
  note_key TEXT PRIMARY KEY,
  company_key TEXT NOT NULL,
  period TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  note_text TEXT NOT NULL,
  item_name TEXT NOT NULL DEFAULT '',
  item_amount REAL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_key) REFERENCES companies(company_key),
  FOREIGN KEY (created_by) REFERENCES employees(employee_key)
);
CREATE INDEX IF NOT EXISTS idx_financial_brief_notes_scope ON financial_brief_notes(company_key, period, metric_key, created_at);
CREATE TABLE IF NOT EXISTS report_snapshots (
  snapshot_key TEXT PRIMARY KEY,
  company_key TEXT NOT NULL,
  period TEXT NOT NULL,
  report_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'validated', 'published', 'superseded', 'archived')),
  source_name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (company_key, period, report_type, version),
  FOREIGN KEY (company_key) REFERENCES companies(company_key),
  FOREIGN KEY (report_type) REFERENCES report_types(report_type)
);
CREATE TABLE IF NOT EXISTS upload_batches (
  upload_key TEXT PRIMARY KEY,
  employee_key TEXT NOT NULL,
  company_key TEXT NOT NULL,
  period TEXT NOT NULL,
  report_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  raw_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploaded', 'parsed', 'validated', 'published', 'superseded', 'rejected')),
  validation_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  published_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (employee_key) REFERENCES employees(employee_key),
  FOREIGN KEY (company_key) REFERENCES companies(company_key),
  FOREIGN KEY (report_type) REFERENCES report_types(report_type)
);
CREATE TABLE IF NOT EXISTS report_lines (
  snapshot_key TEXT NOT NULL,
  line_code TEXT NOT NULL,
  line_name TEXT NOT NULL,
  category TEXT NOT NULL,
  current_amount REAL NOT NULL,
  prior_amount REAL NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (snapshot_key, line_code),
  FOREIGN KEY (snapshot_key) REFERENCES report_snapshots(snapshot_key)
);
CREATE TABLE IF NOT EXISTS report_details (
  snapshot_key TEXT NOT NULL,
  detail_key TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  voucher_no TEXT NOT NULL,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  debit REAL NOT NULL,
  credit REAL NOT NULL,
  balance REAL NOT NULL,
  PRIMARY KEY (snapshot_key, detail_key),
  FOREIGN KEY (snapshot_key) REFERENCES report_snapshots(snapshot_key)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  audit_key INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_key TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL,
  log_type TEXT NOT NULL DEFAULT 'operation',
  module_key TEXT NOT NULL DEFAULT '',
  company_key TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`);

const employeeColumns = new Set(db.prepare('PRAGMA table_info(employees)').all().map(column => column.name));
if (!employeeColumns.has('directory_source')) db.exec("ALTER TABLE employees ADD COLUMN directory_source TEXT NOT NULL DEFAULT 'local'");
if (!employeeColumns.has('directory_synced_at')) db.exec('ALTER TABLE employees ADD COLUMN directory_synced_at TEXT');

const auditLogColumns = new Set(db.prepare('PRAGMA table_info(audit_logs)').all().map(column => column.name));
if (!auditLogColumns.has('log_type')) db.exec("ALTER TABLE audit_logs ADD COLUMN log_type TEXT NOT NULL DEFAULT 'operation'");
if (!auditLogColumns.has('module_key')) db.exec("ALTER TABLE audit_logs ADD COLUMN module_key TEXT NOT NULL DEFAULT ''");
if (!auditLogColumns.has('company_key')) db.exec("ALTER TABLE audit_logs ADD COLUMN company_key TEXT NOT NULL DEFAULT ''");
if (!auditLogColumns.has('period')) db.exec("ALTER TABLE audit_logs ADD COLUMN period TEXT NOT NULL DEFAULT ''");
const financialBriefItemColumns = new Set(db.prepare('PRAGMA table_info(financial_brief_notes)').all().map(column => column.name));
if (!financialBriefItemColumns.has('item_name')) db.exec("ALTER TABLE financial_brief_notes ADD COLUMN item_name TEXT NOT NULL DEFAULT ''");
if (!financialBriefItemColumns.has('item_amount')) db.exec('ALTER TABLE financial_brief_notes ADD COLUMN item_amount REAL');
db.prepare("UPDATE financial_brief_notes SET item_name = note_text WHERE trim(item_name) = ''").run();
db.exec(`
UPDATE audit_logs SET log_type = 'browse' WHERE action LIKE 'view_%' AND log_type = 'operation';
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_employee_created ON audit_logs(employee_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_type_created ON audit_logs(log_type, created_at DESC);
`);

const now = () => new Date().toISOString();
const appSetting = (key, fallback = '') => db.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(key)?.value ?? fallback;
const reportWatermarkEnabled = () => appSetting('report_watermark_enabled', '0') === '1';
const saveAppSetting = (key, value, employeeKey) => db.prepare("INSERT INTO app_settings(setting_key, setting_value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_by = excluded.updated_by, updated_at = excluded.updated_at").run(key, value, employeeKey, now());
const seed = db.transaction(() => {
  if (db.prepare('SELECT COUNT(*) AS count FROM roles').get().count > 0) return;
  const addEmployee = db.prepare('INSERT INTO employees(employee_key, display_name, department) VALUES (?, ?, ?)');
  if (authMode === 'demo') [
    ['admin', '系统管理员', '财务管理部'],
    ['manager', '财务负责人', '财务管理部'],
    ['accountant', '会计小李', '广州财务部'],
    ['viewer', '只读查看员', '业务管理部']
  ].forEach(row => addEmployee.run(...row));
  const addRole = db.prepare('INSERT INTO roles(role_key, role_name, description) VALUES (?, ?, ?)');
  [
    ['admin', '系统管理员', '所有模块和全部报表范围'],
    ['manager', '财务负责人', '全部报表的汇总、明细和导出'],
    ['accountant', '会计人员', '广州公司报表和部分现金流权限'],
    ['viewer', '只读查看员', '全部公司报表汇总，只读不可导出']
  ].forEach(row => addRole.run(...row));
  const addModule = db.prepare('INSERT INTO modules(module_key, module_name) VALUES (?, ?)');
  [
    ['report_summary', '报表汇总'], ['report_detail', '报表明细'], ['permission_admin', '权限管理'],
    ['database_admin', '数据库管理'], [financialBriefModuleKey, '财务数据简报'], ['main_business_analysis', '主营业务分析'], ['expense_analysis', '费用分析'],
    ['group_profit_analysis', '集团合并利润趋势图'], [consultantRoiModuleKey, '顾问投入产出比'], [intercompanyModuleKey, '各公司往来校验']
  ].forEach(row => addModule.run(...row));
  const addCompany = db.prepare('INSERT INTO companies(company_key, company_name) VALUES (?, ?)');
  [['group', '桉侨集团'], ['gz', '广州桉侨'], ['sz', '深圳桉侨'], ['qd', '青岛桉侨']].forEach(row => addCompany.run(...row));
  const addType = db.prepare('INSERT INTO report_types(report_type, report_name) VALUES (?, ?)');
  [['balance_sheet', '资产负债表'], ['income_statement', '利润表'], ['consolidated_income_statement', '桉侨集团合并利润表'], [revenueProfitReportType, '（营收利润口径）合并利润表'], [revenueStatisticsReportType, '营收统计表'], [payrollStatementReportType, '每月工资表'], ['cash_flow', '现金流量表']].forEach(row => addType.run(...row));
  const addEmployeeRole = db.prepare('INSERT INTO employee_roles(employee_key, role_key) VALUES (?, ?)');
  if (authMode === 'demo') [['admin', 'admin'], ['manager', 'manager'], ['accountant', 'accountant'], ['viewer', 'viewer']].forEach(row => addEmployeeRole.run(...row));
  const addPermission = db.prepare('INSERT INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)');
  [['admin', 'report_summary', 'view'], ['admin', 'report_detail', 'view'], ['admin', 'permission_admin', 'manage'], ['admin', 'database_admin', 'view'], ['admin', 'database_admin', 'manage'], ['admin', 'report_summary', 'export'], ['admin', 'report_detail', 'export'],
    ['manager', 'report_summary', 'view'], ['manager', 'report_detail', 'view'], ['manager', 'report_summary', 'export'], ['manager', 'report_detail', 'export'],
    ['accountant', 'report_summary', 'view'], ['accountant', 'report_detail', 'view'], ['accountant', 'report_summary', 'export'],
    ['viewer', 'report_summary', 'view'],
  ['admin', 'main_business_analysis', 'view'], ['manager', 'main_business_analysis', 'view'],
  ['admin', 'expense_analysis', 'view'], ['manager', 'expense_analysis', 'view'],
  ['admin', 'group_profit_analysis', 'view'], ['manager', 'group_profit_analysis', 'view']].forEach(row => addPermission.run(...row));
  const addScope = db.prepare('INSERT INTO role_report_scopes(role_key, report_type, access_level, action, company_key, from_period, to_period) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const allCompanies = '*';
  for (const type of ['balance_sheet', 'income_statement', 'cash_flow']) {
    for (const level of ['summary', 'detail']) {
      for (const action of ['view', 'export']) addScope.run('admin', type, level, action, allCompanies, '2020-01', '2099-12');
      for (const action of ['view', 'export']) addScope.run('manager', type, level, action, allCompanies, '2020-01', '2099-12');
    }
    addScope.run('viewer', type, 'summary', 'view', allCompanies, '2020-01', '2099-12');
  }
  for (const type of ['balance_sheet', 'income_statement']) {
    addScope.run('accountant', type, 'summary', 'view', 'gz', '2026-01', '2026-12');
    addScope.run('accountant', type, 'detail', 'view', 'gz', '2026-01', '2026-12');
    addScope.run('accountant', type, 'summary', 'export', 'gz', '2026-01', '2026-12');
  }
  addScope.run('accountant', 'cash_flow', 'summary', 'view', 'gz', '2026-01', '2026-12');
  if (authMode !== 'demo') return;
  const addSnapshot = db.prepare('INSERT INTO report_snapshots(snapshot_key, company_key, period, report_type, version, status, source_name, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const addLine = db.prepare('INSERT INTO report_lines(snapshot_key, line_code, line_name, category, current_amount, prior_amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const addDetail = db.prepare('INSERT INTO report_details(snapshot_key, detail_key, entry_date, voucher_no, account_code, account_name, summary, debit, credit, balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const lines = {
    balance_sheet: [['cash', '货币资金', '流动资产', 1280000, 1120000], ['receivable', '应收账款', '流动资产', 860000, 780000], ['fixed', '固定资产', '非流动资产', 2140000, 2200000], ['payable', '应付账款', '流动负债', 640000, 590000], ['equity', '所有者权益', '权益', 3640000, 3510000]],
    income_statement: [['revenue', '营业收入', '收入', 3260000, 2980000], ['cost', '营业成本', '成本', 1810000, 1690000], ['admin', '管理费用', '费用', 420000, 390000], ['selling', '销售费用', '费用', 260000, 230000], ['profit', '净利润', '利润', 770000, 670000]],
    cash_flow: [['operating', '经营活动现金流', '经营', 920000, 810000], ['investing', '投资活动现金流', '投资', -260000, -340000], ['financing', '筹资活动现金流', '筹资', 120000, 90000], ['closing', '期末现金余额', '余额', 1280000, 1120000]]
  };
  for (const type of Object.keys(lines)) {
    for (const company of ['gz', 'sz']) {
      for (const period of ['2026-05', '2026-06', '2026-07']) {
        const key = `${company}-${period}-${type}-v1`;
        const factor = company === 'sz' ? 0.72 : 1;
        const monthFactor = period === '2026-05' ? 0.88 : period === '2026-07' ? 1.06 : 1;
        addSnapshot.run(key, company, period, type, 1, 'published', '演示标准数据包.xlsx', '首版演示数据', now());
        lines[type].forEach((line, index) => addLine.run(key, line[0], line[1], line[2], Math.round(line[3] * factor * monthFactor), Math.round(line[4] * factor), index));
        for (let i = 1; i <= 5; i++) addDetail.run(key, `${i}`, `2026-${period.slice(5)}-${String(i + 2).padStart(2, '0')}`, `记-${period.replace('-', '')}-${String(i).padStart(3, '0')}`, `6602${i}`, ['管理费用', '销售费用', '营业成本', '银行存款', '应收账款'][i - 1], ['办公支出', '市场推广', '项目成本', '客户回款', '服务收款'][i - 1], Math.round(12000 * i * factor), Math.round(9000 * i * factor), Math.round(3000 * i * factor));
      }
    }
  }
  const versionKey = 'gz-2026-06-income_statement-v2';
  addSnapshot.run(versionKey, 'gz', '2026-06', 'income_statement', 2, 'published', '人工调整后报表.xlsx', '保留 v1，新增一笔费用调整', now());
  lines.income_statement.forEach((line, index) => addLine.run(versionKey, line[0], line[1], line[2], Math.round(line[3] * (line[0] === 'profit' ? 0.96 : 1.01)), line[4], index));
  for (let i = 1; i <= 6; i++) addDetail.run(versionKey, `${i}`, `2026-06-${String(i + 2).padStart(2, '0')}`, `调-${String(i).padStart(3, '0')}`, `6602${i}`, '管理费用', i === 6 ? '人工调整费用' : '期间费用', i === 6 ? 28000 : 12000 * i, 0, -(i === 6 ? 28000 : 12000 * i));
});
seed();
// 数据导入权限在旧演示数据库上也要幂等补齐，避免升级后必须删除本地数据。
db.prepare("INSERT OR IGNORE INTO modules(module_key, module_name) VALUES ('report_import', '上传报表')").run();
db.prepare("INSERT OR IGNORE INTO modules(module_key, module_name) VALUES ('database_admin', '数据库管理')").run();
db.prepare("INSERT OR IGNORE INTO modules(module_key, module_name) VALUES ('main_business_analysis', '主营业务分析')").run();
db.prepare("INSERT OR IGNORE INTO modules(module_key, module_name) VALUES ('expense_analysis', '费用分析')").run();
db.prepare("INSERT OR IGNORE INTO modules(module_key, module_name) VALUES ('group_profit_analysis', '集团合并利润趋势图')").run();
db.prepare('INSERT OR IGNORE INTO modules(module_key, module_name) VALUES (?, ?)').run(consultantRoiModuleKey, '顾问投入产出比');
db.prepare('INSERT OR IGNORE INTO modules(module_key, module_name) VALUES (?, ?)').run(financialBriefModuleKey, '财务数据简报');
db.prepare("INSERT OR IGNORE INTO companies(company_key, company_name) VALUES ('qd', '青岛桉侨')").run();
db.prepare("INSERT OR IGNORE INTO companies(company_key, company_name) VALUES ('group', '桉侨集团')").run();
db.prepare('INSERT OR IGNORE INTO modules(module_key, module_name) VALUES (?, ?)').run(intercompanyModuleKey, '各公司往来校验');
for (const role of ['admin', 'manager']) for (const action of ['view', 'detail']) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(role, intercompanyModuleKey, action);
for (const row of [['admin', 'database_admin', 'view'], ['admin', 'database_admin', 'manage']]) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(...row);
for (const row of [['admin', 'main_business_analysis', 'view'], ['manager', 'main_business_analysis', 'view']]) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(...row);
for (const row of [['admin', 'expense_analysis', 'view'], ['manager', 'expense_analysis', 'view']]) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(...row);
for (const row of [['admin', 'group_profit_analysis', 'view'], ['manager', 'group_profit_analysis', 'view']]) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(...row);
for (const row of [['admin', consultantRoiModuleKey, 'view'], ['manager', consultantRoiModuleKey, 'view']]) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(...row);
for (const role of ['admin', 'manager', 'accountant', 'viewer']) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(role, financialBriefModuleKey, 'view');
for (const role of ['admin', 'manager']) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(role, financialBriefModuleKey, 'notes.manage');
for (const row of [
  ['admin', 'report_import', 'upload'], ['admin', 'report_import', 'validate'], ['admin', 'report_import', 'publish']
]) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(...row);
if (authMode === 'demo') for (const row of [
  ['manager', 'report_import', 'upload'], ['manager', 'report_import', 'validate'], ['manager', 'report_import', 'publish'],
  ['accountant', 'report_import', 'upload'], ['accountant', 'report_import', 'validate']
]) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(...row);
for (const row of [['admin', 'full'], ['manager', 'full'], ['accountant', 'full'], ['viewer', 'level1']]) db.prepare('INSERT OR IGNORE INTO role_account_visibility(role_key, visibility) VALUES (?, ?)').run(...row);
if (!db.prepare("PRAGMA table_info(role_detail_preferences)").all().some(column => column.name === 'show_full_entry')) db.exec('ALTER TABLE role_detail_preferences ADD COLUMN show_full_entry INTEGER NOT NULL DEFAULT 1');
for (const row of [['admin', 1, 1], ['manager', 1, 1], ['accountant', 1, 1], ['viewer', 0, 1]]) db.prepare('INSERT OR IGNORE INTO role_detail_preferences(role_key, show_direction, show_full_entry) VALUES (?, ?, ?)').run(...row);
for (const row of [['trial_balance', '科目余额表'], ['journal', '序时账']]) db.prepare('INSERT OR IGNORE INTO report_types(report_type, report_name) VALUES (?, ?)').run(...row);
db.prepare("INSERT OR IGNORE INTO report_types(report_type, report_name) VALUES ('consolidated_income_statement', '桉侨集团合并利润表')").run();
db.prepare('INSERT OR IGNORE INTO report_types(report_type, report_name) VALUES (?, ?)').run(revenueProfitReportType, '（营收利润口径）合并利润表');
db.prepare('INSERT OR IGNORE INTO report_types(report_type, report_name) VALUES (?, ?)').run(revenueStatisticsReportType, '营收统计表');
db.prepare('INSERT OR IGNORE INTO report_types(report_type, report_name) VALUES (?, ?)').run(payrollStatementReportType, '每月工资表');
for (const role of ['admin', 'manager', 'viewer']) for (const type of groupOnlyReportTypes) {
  if (sourceOnlyReportTypes.has(type)) continue;
  for (const action of role === 'viewer' ? ['view'] : ['view', 'export']) db.prepare('INSERT OR IGNORE INTO role_report_scopes(role_key, report_type, access_level, action, company_key, from_period, to_period) VALUES (?, ?, ?, ?, ?, ?, ?)').run(role, type, 'summary', action, 'group', '2020-01', '2099-12');
}
db.prepare('DELETE FROM role_report_scopes WHERE report_type = ?').run(payrollStatementReportType);
for (const role of ['admin', 'manager', 'viewer']) for (const type of ['trial_balance', 'journal']) {
  for (const action of role === 'viewer' ? ['view'] : ['view', 'export']) db.prepare('INSERT OR IGNORE INTO role_report_scopes(role_key, report_type, access_level, action, company_key, from_period, to_period) VALUES (?, ?, ?, ?, ?, ?, ?)').run(role, type, 'summary', action, '*', '2020-01', '2099-12');
  if (role !== 'viewer') for (const action of ['view', 'export']) db.prepare('INSERT OR IGNORE INTO role_report_scopes(role_key, report_type, access_level, action, company_key, from_period, to_period) VALUES (?, ?, ?, ?, ?, ?, ?)').run(role, type, 'detail', action, '*', '2020-01', '2099-12');
}
// 地区总经理是权限管理页的业务预设：默认开放三张主报表及三项经营分析。
db.prepare("INSERT OR IGNORE INTO roles(role_key, role_name, description) VALUES ('regional_manager', '地区总经理', '默认浏览三张主报表及三项经营分析')").run();
db.prepare("UPDATE roles SET description = '默认浏览三张主报表及三项经营分析' WHERE role_key = 'regional_manager'").run();
db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run('regional_manager', financialBriefModuleKey, 'view');
for (const row of [
  ['regional_manager', 'report_summary', 'view'],
  ['regional_manager', 'main_business_analysis', 'view'],
  ['regional_manager', 'expense_analysis', 'view']
]) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(...row);
for (const type of ['balance_sheet', 'income_statement', 'cash_flow']) db.prepare('INSERT OR IGNORE INTO role_report_scopes(role_key, report_type, access_level, action, company_key, from_period, to_period) VALUES (?, ?, ?, ?, ?, ?, ?)').run('regional_manager', type, 'summary', 'view', '*', '2020-01', '2099-12');
db.prepare("INSERT OR IGNORE INTO role_account_visibility(role_key, visibility) VALUES ('regional_manager', 'level1')").run();
db.prepare("INSERT OR IGNORE INTO role_detail_preferences(role_key, show_direction, show_full_entry) VALUES ('regional_manager', 0, 0)").run();
for (const row of [
  ['regional_gm', '地区总经理张总', '华南区域'],
  ['new_employee', '新员工王经理', '区域管理部']
]) db.prepare('INSERT OR IGNORE INTO employees(employee_key, display_name, department) VALUES (?, ?, ?)').run(...row);
if (authMode === 'demo') for (const row of [['regional_gm', 'regional_manager'], ['new_employee', 'viewer']]) db.prepare('INSERT OR IGNORE INTO employee_roles(employee_key, role_key) VALUES (?, ?)').run(...row);
// 看板模块顺序是全局配置；旧数据库升级时只补齐缺失模块，不覆盖管理员已有调整。
// 首页是所有员工固定入口，不参与角色授权或模块拖动排序；清理旧版财务总览遗留项。
db.prepare("DELETE FROM role_permissions WHERE module_key = 'dashboard'").run();
db.prepare("DELETE FROM dashboard_module_order WHERE module_key = 'dashboard'").run();
db.prepare("DELETE FROM modules WHERE module_key = 'dashboard'").run();
for (const row of db.prepare('SELECT employee_key AS employeeKey, permission_keys_json AS permissionKeysJson FROM employee_permission_profiles').all()) {
  let keys = []; try { keys = JSON.parse(row.permissionKeysJson); } catch {}
  if (!Array.isArray(keys) || !keys.includes('module.dashboard.view')) continue;
  db.prepare('UPDATE employee_permission_profiles SET permission_keys_json = ? WHERE employee_key = ?').run(JSON.stringify(keys.filter(key => key !== 'module.dashboard.view')), row.employeeKey);
}
const companyOrderFor = () => {
  const rows = db.prepare('SELECT company_key AS key, sort_order AS sortOrder FROM company_display_order ORDER BY sort_order, company_key').all();
  const known = new Set(rows.map(row => row.key)); let next = rows.reduce((max, row) => Math.max(max, Number(row.sortOrder) || 0), 0) + 10;
  for (const company of db.prepare('SELECT company_key AS key FROM companies ORDER BY company_key').all()) {
    if (!known.has(company.key)) { db.prepare('INSERT OR IGNORE INTO company_display_order(company_key, sort_order) VALUES (?, ?)').run(company.key, next); next += 10; }
  }
  return db.prepare('SELECT company_key AS key, sort_order AS sortOrder FROM company_display_order ORDER BY sort_order, company_key').all();
};
const moduleOrderDefaults = [
  [financialBriefModuleKey, 10], ['balance_sheet', 20], ['income_statement', 30], ['consolidated_income_statement', 35], [revenueProfitReportType, 36], ['group_profit_analysis', 37], [revenueStatisticsReportType, 38], [consultantRoiModuleKey, 39], ['cash_flow', 40],
  ['trial_balance', 50], ['journal', 60], ['cash_analysis', 70], ['main_business_analysis', 80], ['expense_analysis', 90], [intercompanyModuleKey, 95], ['uploads', 100], [activityLogModuleKey, 105], ['permissions', 110], ['database_admin', 120]
];
for (const row of moduleOrderDefaults) db.prepare('INSERT OR IGNORE INTO dashboard_module_order(module_key, sort_order) VALUES (?, ?)').run(...row);
const moduleOrderFor = () => {
  const rows = db.prepare('SELECT module_key AS key, sort_order AS sortOrder FROM dashboard_module_order ORDER BY sort_order, module_key').all();
  const known = new Set(rows.map(row => row.key));
  let next = rows.reduce((max, row) => Math.max(max, Number(row.sortOrder) || 0), 0) + 10;
  for (const type of db.prepare('SELECT report_type AS key FROM report_types ORDER BY rowid').all()) {
    if (!known.has(type.key)) { db.prepare('INSERT OR IGNORE INTO dashboard_module_order(module_key, sort_order) VALUES (?, ?)').run(type.key, next); next += 10; }
  }
  return db.prepare('SELECT module_key AS key, sort_order AS sortOrder FROM dashboard_module_order ORDER BY sort_order, module_key').all();
};
// 仅迁移一次既有全局顺序；之后管理员仍可继续自由拖动。
const uploadPlacementMigrationKey = 'module_order_uploads_before_permissions_v1';
if (appSetting(uploadPlacementMigrationKey, '0') !== '1') {
  const currentOrder = moduleOrderFor().map(row => row.key).filter(key => key !== 'uploads');
  const permissionsIndex = currentOrder.indexOf('permissions');
  currentOrder.splice(permissionsIndex < 0 ? currentOrder.length : permissionsIndex, 0, 'uploads');
  db.transaction(() => currentOrder.forEach((key, index) => db.prepare('UPDATE dashboard_module_order SET sort_order = ? WHERE module_key = ?').run((index + 1) * 10, key)))();
  saveAppSetting(uploadPlacementMigrationKey, '1', 'system');
}
const financialBriefPlacementMigrationKey = 'module_order_financial_brief_before_balance_sheet_v1';
if (appSetting(financialBriefPlacementMigrationKey, '0') !== '1') {
  const currentOrder = moduleOrderFor().map(row => row.key).filter(key => key !== financialBriefModuleKey);
  const balanceSheetIndex = currentOrder.indexOf('balance_sheet');
  currentOrder.splice(balanceSheetIndex < 0 ? 0 : balanceSheetIndex, 0, financialBriefModuleKey);
  db.transaction(() => currentOrder.forEach((key, index) => db.prepare('UPDATE dashboard_module_order SET sort_order = ? WHERE module_key = ?').run((index + 1) * 10, key)))();
  saveAppSetting(financialBriefPlacementMigrationKey, '1', 'system');
}
const intercompanyPlacementMigrationKey = 'module_order_intercompany_before_uploads_v1';
if (appSetting(intercompanyPlacementMigrationKey, '0') !== '1') {
  const currentOrder = moduleOrderFor().map(row => row.key).filter(key => key !== intercompanyModuleKey);
  const uploadsIndex = currentOrder.indexOf('uploads');
  currentOrder.splice(uploadsIndex < 0 ? currentOrder.length : uploadsIndex, 0, intercompanyModuleKey);
  db.transaction(() => currentOrder.forEach((key, index) => db.prepare('UPDATE dashboard_module_order SET sort_order = ? WHERE module_key = ?').run((index + 1) * 10, key)))();
  saveAppSetting(intercompanyPlacementMigrationKey, '1', 'system');
}
const activityLogPlacementMigrationKey = 'module_order_activity_logs_before_permissions_v1';
if (appSetting(activityLogPlacementMigrationKey, '0') !== '1') {
  const currentOrder = moduleOrderFor().map(row => row.key).filter(key => key !== activityLogModuleKey);
  const permissionsIndex = currentOrder.indexOf('permissions');
  currentOrder.splice(permissionsIndex < 0 ? currentOrder.length : permissionsIndex, 0, activityLogModuleKey);
  db.transaction(() => currentOrder.forEach((key, index) => db.prepare('UPDATE dashboard_module_order SET sort_order = ? WHERE module_key = ?').run((index + 1) * 10, key)))();
  saveAppSetting(activityLogPlacementMigrationKey, '1', 'system');
}
const analysisBlockDefaults = {
  cash_analysis: ['cash_metric', 'internal_metric', 'core_metric', 'receivables_metric', 'static_metric', 'liquidity_guide', 'cash_source', 'net_positions', 'cash_accounts', 'other_liquidity', 'core_liquidity_trend'],
  main_business_analysis: ['business_source', 'revenue_metric', 'cost_metric', 'gross_metric', 'project_count_metric', 'business_detail', 'project_change', 'gross_trend'],
  expense_analysis: ['expense_source', 'selling_table', 'selling_share', 'selling_trend', 'admin_table', 'admin_share', 'admin_trend', 'finance_table', 'finance_share', 'finance_methods'],
  group_profit_analysis: ['group_profit_source', 'revenue_cost_trend', 'period_expense_trend', 'net_profit_trend'],
  [consultantRoiModuleKey]: ['consultant_roi_source', 'consultant_roi_metrics', 'consultant_roi_table']
};
const appendMissingAnalysisBlocks = pageKey => {
  const keys = analysisBlockDefaults[pageKey] || [];
  const existing = db.prepare('SELECT block_key AS key, sort_order AS sortOrder FROM analysis_block_order WHERE page_key = ? ORDER BY sort_order, block_key').all(pageKey);
  const known = new Set(existing.map(row => row.key));
  let next = existing.reduce((maximum, row) => Math.max(maximum, Number(row.sortOrder) || 0), 0) + 10;
  for (const blockKey of keys) {
    if (known.has(blockKey)) continue;
    db.prepare('INSERT OR IGNORE INTO analysis_block_order(page_key, block_key, sort_order) VALUES (?, ?, ?)').run(pageKey, blockKey, next);
    next += 10;
  }
};
Object.keys(analysisBlockDefaults).forEach(appendMissingAnalysisBlocks);
// 仅整理一次历史版本可能产生的并列序号；按现有查询顺序重编号，不按默认布局覆盖管理员顺序。
const analysisBlockOrderNormalizationKey = 'analysis_block_order_stable_upgrade_v1';
if (appSetting(analysisBlockOrderNormalizationKey, '0') !== '1') {
  db.transaction(() => {
    for (const pageKey of Object.keys(analysisBlockDefaults)) {
      appendMissingAnalysisBlocks(pageKey);
      const rows = db.prepare('SELECT block_key AS key FROM analysis_block_order WHERE page_key = ? ORDER BY sort_order, block_key').all(pageKey);
      rows.forEach((row, index) => db.prepare('UPDATE analysis_block_order SET sort_order = ? WHERE page_key = ? AND block_key = ?').run((index + 1) * 10, pageKey, row.key));
    }
    saveAppSetting(analysisBlockOrderNormalizationKey, '1', 'system');
  })();
}
const analysisBlockOrderFor = pageKey => {
  const keys = analysisBlockDefaults[pageKey] || [];
  appendMissingAnalysisBlocks(pageKey);
  return db.prepare('SELECT block_key AS key FROM analysis_block_order WHERE page_key = ? ORDER BY sort_order, block_key').all(pageKey).map(row => row.key).filter(key => keys.includes(key));
};
const allAnalysisBlockOrders = () => Object.fromEntries(Object.keys(analysisBlockDefaults).map(pageKey => [pageKey, analysisBlockOrderFor(pageKey)]));
const uploadsDir = process.env.UPLOADS_DIR || path.join(dataDir, 'uploads');
ensurePrivateDirectory(uploadsDir);

const json = (res, status, value, headers = {}) => { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(body); };
const text = (res, status, value, contentType = 'text/plain; charset=utf-8') => { res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' }); res.end(value); };
const redirect = (res, location, headers = {}) => { res.writeHead(302, { location, 'cache-control': 'no-store', ...headers }); res.end(); };
const bad = (res, status, message, details = {}) => json(res, status, { error: message, ...details });
const securityHeaders = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};
const applySecurityHeaders = res => { for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value); };
const isAllowedApiRequestSource = req => {
  const origin = String(req.headers.origin || '').trim().replace(/\/+$/, '');
  const expectedOrigin = financeAllowedOrigin || `http://${String(req.headers.host || '').trim()}`;
  if (origin && origin !== expectedOrigin) return false;
  const fetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  return true;
};
const sessionCookieName = publicBaseUrl.startsWith('https://') && !appBasePath ? '__Host-wecom_finance_session' : 'wecom_finance_session';
const parseCookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(item => item.trim()).filter(Boolean).map(item => { const index = item.indexOf('='); return index < 0 ? [item, ''] : [item.slice(0, index), decodeURIComponent(item.slice(index + 1))]; }));
const signPayload = payload => { const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url'); const signature = crypto.createHmac('sha256', sessionSecret).update(encoded).digest('base64url'); return `${encoded}.${signature}`; };
const verifyPayload = (token, expectedType = 'session') => {
  try {
    const [encoded, supplied] = String(token || '').split('.'); if (!encoded || !supplied) return null;
    const expected = crypto.createHmac('sha256', sessionSecret).update(encoded).digest(); const actual = Buffer.from(supplied, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload.type === expectedType && Number(payload.exp) > Math.floor(Date.now() / 1000) ? payload : null;
  } catch { return null; }
};
const sessionCookiePath = appBasePath || '/';
const sessionCookie = employeeKey => `${sessionCookieName}=${encodeURIComponent(signPayload({ type: 'platform-session', sub: employeeKey, exp: Math.floor(Date.now() / 1000) + 15 * 60 }))}; Path=${sessionCookiePath}; HttpOnly; SameSite=Strict; Max-Age=900${publicBaseUrl.startsWith('https://') ? '; Secure' : ''}`;
const clearSessionCookie = () => `${sessionCookieName}=; Path=${sessionCookiePath}; HttpOnly; SameSite=Strict; Max-Age=0${publicBaseUrl.startsWith('https://') ? '; Secure' : ''}`;
const authenticatedEmployeeKeyFrom = req => authMode === 'demo'
  ? (req.headers['x-demo-employee'] || process.env.DEV_EMPLOYEE || 'admin')
  : verifyPayload(parseCookies(req)[sessionCookieName], 'platform-session')?.sub;
const employeeFrom = req => {
  const key = authenticatedEmployeeKeyFrom(req);
  return key ? db.prepare('SELECT * FROM employees WHERE employee_key = ? AND active = 1').get(key) : null;
};
const directorySyncState = () => {
  const source = authMode === 'platform' ? 'platform' : 'demo';
  const row = db.prepare('SELECT status, last_attempt_at AS lastAttemptAt, last_success_at AS lastSuccessAt, last_error AS lastError, employee_count AS employeeCount FROM directory_sync_state WHERE source = ?').get(source);
  return row || { status: authMode === 'platform' ? 'never' : 'demo', lastAttemptAt: null, lastSuccessAt: null, lastError: '', employeeCount: db.prepare('SELECT COUNT(*) AS count FROM employees WHERE active = 1').get().count };
};
class PlatformApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const allowedPlatformIdentityPaths = new Set(['/auth/me', '/data-dist/my-roles', '/data-dist/user-groups']);
const platformJson = async (pathname, accessToken) => {
  if (!allowedPlatformIdentityPaths.has(pathname)) throw new PlatformApiError(500, '平台身份接口不在财务服务白名单中');
  const response = await fetch(`${platformApiBaseUrl}${pathname}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    body: undefined,
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) throw new PlatformApiError(401, '小Q登录状态已失效');
  if (response.status === 403) throw new PlatformApiError(403, '小Q账号没有读取成员分组的权限');
  if (!response.ok) throw new PlatformApiError(502, `小Q认证服务暂不可用（${response.status}）`);
  return unwrapPlatformData(payload);
};
const upsertPlatformEmployee = identity => {
  const existed = db.prepare('SELECT 1 FROM employees WHERE employee_key = ?').get(identity.employeeKey);
  db.prepare("INSERT INTO employees(employee_key, display_name, department, active, directory_source, directory_synced_at) VALUES (?, ?, ?, 1, 'platform', ?) ON CONFLICT(employee_key) DO UPDATE SET display_name = excluded.display_name, department = excluded.department, active = 1, directory_source = 'platform', directory_synced_at = excluded.directory_synced_at").run(identity.employeeKey, identity.displayName, identity.department, now());
  if (!existed && !db.prepare('SELECT 1 FROM employee_permission_profiles WHERE employee_key = ?').get(identity.employeeKey)) {
    db.prepare("INSERT INTO employee_permission_profiles(employee_key, preset_role_key, permission_keys_json, company_keys_json, from_period, to_period, account_visibility, show_direction, show_full_entry, updated_by, updated_at) VALUES (?, 'viewer', '[]', '[]', '2020-01', '2099-12', 'level1', 0, 0, 'platform_auth', ?)").run(identity.employeeKey, now());
  }
  return db.prepare('SELECT * FROM employees WHERE employee_key = ?').get(identity.employeeKey);
};
const syncPlatformDirectory = (groups, actorKey) => {
  const members = platformDirectoryMembers(groups);
  const attemptedAt = now(); const syncedAt = now();
  const save = db.transaction(() => {
    const upsert = db.prepare("INSERT INTO employees(employee_key, display_name, department, active, directory_source, directory_synced_at) VALUES (?, ?, ?, 1, 'platform', ?) ON CONFLICT(employee_key) DO UPDATE SET display_name = excluded.display_name, department = excluded.department, active = 1, directory_source = 'platform', directory_synced_at = excluded.directory_synced_at");
    for (const member of members) upsert.run(member.employeeKey, member.displayName, member.department, syncedAt);
    const allowedKeys = new Set(members.map(member => member.employeeKey));
    for (const row of db.prepare("SELECT employee_key AS employeeKey FROM employees WHERE directory_source IN ('platform', 'wecom')").all()) {
      if (!allowedKeys.has(row.employeeKey)) db.prepare('UPDATE employees SET active = 0 WHERE employee_key = ?').run(row.employeeKey);
    }
    db.prepare("INSERT INTO directory_sync_state(source, status, last_attempt_at, last_success_at, last_error, employee_count) VALUES ('platform', 'success', ?, ?, '', ?) ON CONFLICT(source) DO UPDATE SET status = 'success', last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at, last_error = '', employee_count = excluded.employee_count").run(attemptedAt, syncedAt, members.length);
  });
  save(); log(actorKey, 'sync_platform_directory', 'platform_directory', `employees=${members.length}`);
  return directorySyncState();
};
const rolesFor = employeeKey => db.prepare('SELECT r.* FROM roles r JOIN employee_roles er ON er.role_key = r.role_key WHERE er.employee_key = ?').all(employeeKey);
const reportPermissionNode = (id, name) => ({ id, name, children: [
  { key: `report.${id}.summary.view`, name: '浏览报表' },
  { key: `report.${id}.summary.export`, name: '导出报表' },
  { key: `report.${id}.detail.view`, name: '查看明细' },
  { key: `report.${id}.detail.export`, name: '导出明细' }
] });
const summaryReportPermissionNode = (id, name) => ({ id, name, children: [
  { key: `report.${id}.summary.view`, name: '浏览报表' },
  { key: `report.${id}.summary.export`, name: '导出报表' }
] });
const analysisPermissionNode = pageKey => {
  const definition = analysisBlockPermissionDefinitions[pageKey];
  return { id: `${pageKey}_permissions`, name: definition.pageName, description: '页面和下方子模块分别授权', children: [
    { key: `module.${pageKey}.view`, name: `浏览${definition.pageName}`, permissionLevel: 'page' },
    ...Object.entries(definition.blocks).map(([blockKey, name]) => ({ key: analysisBlockPermissionKey(pageKey, blockKey), name: `查看${name}`, parentPageKey: pageKey, permissionLevel: 'block' }))
  ] };
};
const permissionCatalog = [
  { id: 'reports', name: '财务报表', description: '每张报表的浏览、明细和导出独立控制', children: [
    reportPermissionNode('balance_sheet', '资产负债表'), reportPermissionNode('income_statement', '利润表'), summaryReportPermissionNode('consolidated_income_statement', '桉侨集团合并利润表'), summaryReportPermissionNode(revenueProfitReportType, '（营收利润口径）合并利润表'), summaryReportPermissionNode(revenueStatisticsReportType, '营收统计表'), reportPermissionNode('cash_flow', '现金流量表'), reportPermissionNode('trial_balance', '科目余额表'), reportPermissionNode('journal', '序时账')
  ] },
  { id: 'analysis', name: '经营分析', description: '分析页只开放聚合结果，不自动开放底层序时账', children: [
    { id: 'financial_brief_permissions', name: '财务数据简报', description: '简报浏览与二级项目编辑分别授权', children: [
      { key: 'module.financial_brief.view', name: '浏览财务数据简报' },
      { key: financialBriefNotesPermissionKey, name: '编辑二级项目明细' }
    ] },
    analysisPermissionNode('cash_analysis'),
    analysisPermissionNode('main_business_analysis'),
    analysisPermissionNode('expense_analysis'),
    { key: 'module.group_profit_analysis.view', name: '集团合并利润趋势图 · 浏览' },
    { key: 'module.consultant_roi_analysis.view', name: '顾问投入产出比 · 浏览' },
    { id: 'intercompany_reconciliation_permissions', name: '各公司往来校验', description: '集团汇总与序时账下钻分别授权', children: [
      { key: intercompanyViewPermissionKey, name: '浏览各公司往来校验' },
      { key: intercompanyDetailPermissionKey, name: '查看双方序时账明细' }
    ] }
  ] },
  { id: 'uploads', name: '报表上传', description: '上传、校验和发布逐级授权', children: [
    { key: 'module.uploads.upload', name: '上传文件' }, { key: 'module.uploads.validate', name: '校验批次' }, { key: 'module.uploads.publish', name: '发布版本' }
  ] },
  { id: 'system', name: '系统管理', description: '高风险权限，保存前应复核', children: [
    { key: 'module.permissions.manage', name: '权限管理' }, { key: 'module.database.view', name: '数据库浏览' }, { key: 'module.database.manage', name: '数据库管理' }
  ] }
];
const permissionLeaves = nodes => nodes.flatMap(node => node.key ? [node] : permissionLeaves(node.children || []));
const validPermissionKeys = new Set(permissionLeaves(permissionCatalog).map(item => item.key));
const intercompanyPermissionMigrationKey = 'intercompany_reconciliation_permission_v1';
if (appSetting(intercompanyPermissionMigrationKey, '0') !== '1') {
  for (const row of db.prepare('SELECT employee_key AS employeeKey, permission_keys_json AS permissionKeysJson, company_keys_json AS companyKeysJson FROM employee_permission_profiles').all()) {
    let keys = []; try { keys = JSON.parse(row.permissionKeysJson); } catch {}
    if (!Array.isArray(keys)) continue;
    const isFinanceProfile = keys.includes('module.permissions.manage') || keys.includes('report.journal.detail.view');
    if (!isFinanceProfile) continue;
    keys.push(intercompanyViewPermissionKey);
    if (keys.includes('report.journal.detail.view')) keys.push(intercompanyDetailPermissionKey);
    let companyKeys = []; try { companyKeys = JSON.parse(row.companyKeysJson); } catch {}
    if (Array.isArray(companyKeys) && !companyKeys.includes('*') && !companyKeys.includes('group')) companyKeys.push('group');
    db.prepare('UPDATE employee_permission_profiles SET permission_keys_json = ?, company_keys_json = ? WHERE employee_key = ?').run(JSON.stringify([...new Set(keys)].sort()), JSON.stringify([...new Set(companyKeys)].sort()), row.employeeKey);
  }
  saveAppSetting(intercompanyPermissionMigrationKey, '1', 'system');
}
const cashNetPositionsPermissionMigrationKey = 'cash_analysis_net_positions_permission_v1';
if (appSetting(cashNetPositionsPermissionMigrationKey, '0') !== '1') {
  for (const row of db.prepare('SELECT employee_key AS employeeKey, permission_keys_json AS permissionKeysJson FROM employee_permission_profiles').all()) {
    let keys = []; try { keys = JSON.parse(row.permissionKeysJson); } catch {}
    if (!Array.isArray(keys) || !keys.includes('module.cash_analysis.view')) continue;
    keys = [...new Set([...keys, cashNetPositionsPermissionKey])].sort();
    db.prepare('UPDATE employee_permission_profiles SET permission_keys_json = ? WHERE employee_key = ?').run(JSON.stringify(keys), row.employeeKey);
  }
  saveAppSetting(cashNetPositionsPermissionMigrationKey, '1', 'system');
}
const analysisBlockPermissionsMigrationKey = 'analysis_block_permissions_all_marked_modules_v1';
if (appSetting(analysisBlockPermissionsMigrationKey, '0') !== '1') {
  const migrate = db.transaction(() => {
    for (const row of db.prepare('SELECT employee_key AS employeeKey, permission_keys_json AS permissionKeysJson FROM employee_permission_profiles').all()) {
      let keys = []; try { keys = JSON.parse(row.permissionKeysJson); } catch {}
      if (!Array.isArray(keys)) continue;
      const selected = new Set(keys);
      for (const pageKey of Object.keys(analysisBlockPermissionDefinitions)) {
        if (!selected.has(`module.${pageKey}.view`)) continue;
        analysisBlockPermissionKeys(pageKey).forEach(key => selected.add(key));
      }
      db.prepare('UPDATE employee_permission_profiles SET permission_keys_json = ? WHERE employee_key = ?').run(JSON.stringify([...selected].sort()), row.employeeKey);
    }
    saveAppSetting(analysisBlockPermissionsMigrationKey, '1', 'system');
  });
  migrate();
}
const financialBriefPermissionMigrationKey = 'financial_brief_permission_v1';
if (appSetting(financialBriefPermissionMigrationKey, '0') !== '1') {
  for (const row of db.prepare('SELECT employee_key AS employeeKey, permission_keys_json AS permissionKeysJson FROM employee_permission_profiles').all()) {
    let keys = []; try { keys = JSON.parse(row.permissionKeysJson); } catch {}
    if (!Array.isArray(keys)) continue;
    const canViewFinancialSource = keys.some(key => [
      'report.balance_sheet.summary.view', 'report.income_statement.summary.view',
      'report.consolidated_income_statement.summary.view', `report.${revenueProfitReportType}.summary.view`
    ].includes(key));
    if (!canViewFinancialSource) continue;
    keys = [...new Set([...keys, 'module.financial_brief.view'])].sort();
    db.prepare('UPDATE employee_permission_profiles SET permission_keys_json = ? WHERE employee_key = ?').run(JSON.stringify(keys), row.employeeKey);
  }
  saveAppSetting(financialBriefPermissionMigrationKey, '1', 'system');
}
const financialBriefNotesPermissionMigrationKey = 'financial_brief_notes_permission_v1';
if (appSetting(financialBriefNotesPermissionMigrationKey, '0') !== '1') {
  for (const row of db.prepare('SELECT employee_key AS employeeKey, preset_role_key AS presetRoleKey, permission_keys_json AS permissionKeysJson FROM employee_permission_profiles').all()) {
    let keys = []; try { keys = JSON.parse(row.permissionKeysJson); } catch {}
    if (!Array.isArray(keys) || !['admin', 'manager'].includes(row.presetRoleKey)) continue;
    keys = [...new Set([...keys, 'module.financial_brief.view', financialBriefNotesPermissionKey])].sort();
    db.prepare('UPDATE employee_permission_profiles SET permission_keys_json = ? WHERE employee_key = ?').run(JSON.stringify(keys), row.employeeKey);
  }
  saveAppSetting(financialBriefNotesPermissionMigrationKey, '1', 'system');
}
const consolidatedPermissionMigrationKey = 'admin_consolidated_income_permission_v1';
if (appSetting(consolidatedPermissionMigrationKey, '0') !== '1') {
  for (const row of db.prepare('SELECT employee_key AS employeeKey, permission_keys_json AS permissionKeysJson, company_keys_json AS companyKeysJson FROM employee_permission_profiles').all()) {
    let keys = []; try { keys = JSON.parse(row.permissionKeysJson); } catch {}
    if (!Array.isArray(keys) || !keys.includes('module.permissions.manage')) continue;
    keys = [...new Set([...keys, 'report.consolidated_income_statement.summary.view', 'report.consolidated_income_statement.summary.export'])].sort();
    let companyKeys = []; try { companyKeys = JSON.parse(row.companyKeysJson); } catch {}
    if (Array.isArray(companyKeys) && !companyKeys.includes('*')) companyKeys = [...new Set([...companyKeys, 'group'])].sort();
    db.prepare('UPDATE employee_permission_profiles SET permission_keys_json = ?, company_keys_json = ? WHERE employee_key = ?').run(JSON.stringify(keys), JSON.stringify(companyKeys), row.employeeKey);
  }
  saveAppSetting(consolidatedPermissionMigrationKey, '1', 'system');
}
const revenueProfitPermissionMigrationKey = 'admin_revenue_profit_consolidated_permission_v1';
if (appSetting(revenueProfitPermissionMigrationKey, '0') !== '1') {
  for (const row of db.prepare('SELECT employee_key AS employeeKey, permission_keys_json AS permissionKeysJson, company_keys_json AS companyKeysJson FROM employee_permission_profiles').all()) {
    let keys = []; try { keys = JSON.parse(row.permissionKeysJson); } catch {}
    if (!Array.isArray(keys) || !keys.includes('module.permissions.manage')) continue;
    keys = [...new Set([...keys, `report.${revenueProfitReportType}.summary.view`, `report.${revenueProfitReportType}.summary.export`])].sort();
    let companyKeys = []; try { companyKeys = JSON.parse(row.companyKeysJson); } catch {}
    if (Array.isArray(companyKeys) && !companyKeys.includes('*')) companyKeys = [...new Set([...companyKeys, 'group'])].sort();
    db.prepare('UPDATE employee_permission_profiles SET permission_keys_json = ?, company_keys_json = ? WHERE employee_key = ?').run(JSON.stringify(keys), JSON.stringify(companyKeys), row.employeeKey);
  }
  saveAppSetting(revenueProfitPermissionMigrationKey, '1', 'system');
}
const revenueStatisticsPermissionMigrationKey = 'revenue_statistics_permission_v1';
if (appSetting(revenueStatisticsPermissionMigrationKey, '0') !== '1') {
  for (const row of db.prepare('SELECT employee_key AS employeeKey, permission_keys_json AS permissionKeysJson, company_keys_json AS companyKeysJson FROM employee_permission_profiles').all()) {
    let keys = []; try { keys = JSON.parse(row.permissionKeysJson); } catch {}
    if (!Array.isArray(keys)) continue;
    const canViewGroupReport = keys.some(key => ['report.consolidated_income_statement.summary.view', `report.${revenueProfitReportType}.summary.view`].includes(key));
    const canExportGroupReport = keys.some(key => ['report.consolidated_income_statement.summary.export', `report.${revenueProfitReportType}.summary.export`].includes(key));
    if (!canViewGroupReport && !canExportGroupReport) continue;
    if (canViewGroupReport) keys.push(`report.${revenueStatisticsReportType}.summary.view`);
    if (canExportGroupReport) keys.push(`report.${revenueStatisticsReportType}.summary.export`);
    keys = [...new Set(keys)].sort();
    let companyKeys = []; try { companyKeys = JSON.parse(row.companyKeysJson); } catch {}
    if (Array.isArray(companyKeys) && !companyKeys.includes('*') && !companyKeys.includes('group')) companyKeys = [...companyKeys, 'group'].sort();
    db.prepare('UPDATE employee_permission_profiles SET permission_keys_json = ?, company_keys_json = ? WHERE employee_key = ?').run(JSON.stringify(keys), JSON.stringify(companyKeys), row.employeeKey);
  }
  saveAppSetting(revenueStatisticsPermissionMigrationKey, '1', 'system');
}
const groupProfitPermissionMigrationKey = 'admin_group_profit_analysis_permission_v1';
if (appSetting(groupProfitPermissionMigrationKey, '0') !== '1') {
  for (const row of db.prepare('SELECT employee_key AS employeeKey, permission_keys_json AS permissionKeysJson FROM employee_permission_profiles').all()) {
    let keys = []; try { keys = JSON.parse(row.permissionKeysJson); } catch {}
    if (!Array.isArray(keys) || !keys.includes('module.permissions.manage')) continue;
    keys = [...new Set([...keys, 'module.group_profit_analysis.view'])].sort();
    db.prepare('UPDATE employee_permission_profiles SET permission_keys_json = ? WHERE employee_key = ?').run(JSON.stringify(keys), row.employeeKey);
  }
  saveAppSetting(groupProfitPermissionMigrationKey, '1', 'system');
}
const consultantRoiPermissionMigrationKey = 'consultant_roi_analysis_permission_v1';
if (appSetting(consultantRoiPermissionMigrationKey, '0') !== '1') {
  for (const row of db.prepare('SELECT employee_key AS employeeKey, permission_keys_json AS permissionKeysJson FROM employee_permission_profiles').all()) {
    let keys = []; try { keys = JSON.parse(row.permissionKeysJson); } catch {}
    if (!Array.isArray(keys) || !keys.some(key => ['module.permissions.manage', 'module.group_profit_analysis.view'].includes(key))) continue;
    keys = [...new Set([...keys, 'module.consultant_roi_analysis.view'])].sort();
    db.prepare('UPDATE employee_permission_profiles SET permission_keys_json = ? WHERE employee_key = ?').run(JSON.stringify(keys), row.employeeKey);
  }
  saveAppSetting(consultantRoiPermissionMigrationKey, '1', 'system');
}
const modulePermissionKey = (moduleKey, action) => ({
  report_import: `module.uploads.${action}`,
  permission_admin: `module.permissions.${action}`,
  database_admin: `module.database.${action}`,
  cash_analysis: `module.cash_analysis.${action}`,
  main_business_analysis: `module.main_business_analysis.${action}`,
  expense_analysis: `module.expense_analysis.${action}`,
  [financialBriefModuleKey]: `module.financial_brief.${action}`,
  group_profit_analysis: `module.group_profit_analysis.${action}`,
  [consultantRoiModuleKey]: `module.consultant_roi_analysis.${action}`,
  [intercompanyModuleKey]: `module.${intercompanyModuleKey}.${action}`
}[moduleKey]);
const permissionKeysForRole = roleKey => {
  const keys = new Set();
  for (const row of db.prepare('SELECT module_key AS moduleKey, action FROM role_permissions WHERE role_key = ?').all(roleKey)) {
    const key = modulePermissionKey(row.moduleKey, row.action); if (key && validPermissionKeys.has(key)) keys.add(key);
  }
  for (const row of db.prepare('SELECT report_type AS reportType, access_level AS level, action FROM role_report_scopes WHERE role_key = ?').all(roleKey)) {
    const key = `report.${row.reportType}.${row.level}.${row.action}`; if (validPermissionKeys.has(key)) keys.add(key);
  }
  if (keys.has('report.cash_flow.summary.view')) keys.add('module.cash_analysis.view');
  for (const pageKey of Object.keys(analysisBlockPermissionDefinitions)) {
    if (keys.has(`module.${pageKey}.view`)) analysisBlockPermissionKeys(pageKey).forEach(key => keys.add(key));
  }
  return [...keys].sort();
};
const roleDefaultFor = roleKey => {
  const scopes = db.prepare('SELECT company_key AS companyKey, from_period AS fromPeriod, to_period AS toPeriod FROM role_report_scopes WHERE role_key = ?').all(roleKey);
  const companies = [...new Set(scopes.map(item => item.companyKey))];
  const accountVisibility = db.prepare('SELECT visibility FROM role_account_visibility WHERE role_key = ?').get(roleKey)?.visibility || 'level1';
  const preference = db.prepare('SELECT show_direction AS showDirection, show_full_entry AS showFullEntry FROM role_detail_preferences WHERE role_key = ?').get(roleKey);
  return { roleKey, permissionKeys: permissionKeysForRole(roleKey), companyKeys: companies.includes('*') || !companies.length ? ['*'] : companies, fromPeriod: scopes.map(item => item.fromPeriod).sort()[0] || '2020-01', toPeriod: scopes.map(item => item.toPeriod).sort().at(-1) || '2099-12', accountVisibility, showDirection: preference ? Number(preference.showDirection) === 1 : true, showFullEntry: preference ? Number(preference.showFullEntry) === 1 : true };
};
const parseArray = value => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } };
const permissionProfileFor = employeeKey => {
  const saved = db.prepare('SELECT preset_role_key AS presetRoleKey, permission_keys_json AS permissionKeysJson, company_keys_json AS companyKeysJson, from_period AS fromPeriod, to_period AS toPeriod, account_visibility AS accountVisibility, show_direction AS showDirection, show_full_entry AS showFullEntry, updated_at AS updatedAt FROM employee_permission_profiles WHERE employee_key = ?').get(employeeKey);
  if (saved) return { employeeKey, presetRoleKey: saved.presetRoleKey, permissionKeys: parseArray(saved.permissionKeysJson), companyKeys: parseArray(saved.companyKeysJson), fromPeriod: saved.fromPeriod, toPeriod: saved.toPeriod, accountVisibility: saved.accountVisibility, showDirection: Number(saved.showDirection) === 1, showFullEntry: Number(saved.showFullEntry) === 1, hasAssignment: true, isCustomized: true, updatedAt: saved.updatedAt };
  const roleKeys = db.prepare('SELECT role_key AS roleKey FROM employee_roles WHERE employee_key = ? ORDER BY rowid').all(employeeKey).map(row => row.roleKey);
  const defaults = roleKeys.map(roleDefaultFor); const permissionKeys = [...new Set(defaults.flatMap(item => item.permissionKeys))].sort(); const companies = [...new Set(defaults.flatMap(item => item.companyKeys))];
  const companyKeys = roleKeys.length ? (companies.includes('*') || !companies.length ? ['*'] : companies) : [];
  return { employeeKey, presetRoleKey: roleKeys[0] || 'viewer', permissionKeys, companyKeys, fromPeriod: defaults.map(item => item.fromPeriod).sort()[0] || '2020-01', toPeriod: defaults.map(item => item.toPeriod).sort().at(-1) || '2099-12', accountVisibility: defaults.some(item => item.accountVisibility === 'full') ? 'full' : 'level1', showDirection: defaults.length ? defaults.some(item => item.showDirection) : true, showFullEntry: defaults.length ? defaults.some(item => item.showFullEntry) : true, hasAssignment: roleKeys.length > 0, isCustomized: false, updatedAt: null };
};
const profileScopeAllows = (profile, companyKey, period) => (profile.companyKeys.includes('*') || profile.companyKeys.includes(companyKey)) && profile.fromPeriod <= period && profile.toPeriod >= period;
const authorizedCompaniesFor = employeeKey => {
  const profile = permissionProfileFor(employeeKey);
  const order = new Map(companyOrderFor().map((item, index) => [item.key, index]));
  const companies = db.prepare('SELECT company_key AS key, company_name AS name FROM companies').all().sort((a, b) => (order.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.key) ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key));
  return profile.companyKeys.includes('*') ? companies : companies.filter(company => profile.companyKeys.includes(company.key));
};
const hasPermissionKey = (employeeKey, key, companyKey, period) => { const profile = permissionProfileFor(employeeKey); return profile.permissionKeys.includes(key) && (!companyKey || !period || profileScopeAllows(profile, companyKey, period)); };
const hasModule = (employeeKey, moduleKey, action) => {
  const profile = permissionProfileFor(employeeKey);
  if (moduleKey === 'report_summary' || moduleKey === 'report_detail') return profile.permissionKeys.some(key => key.startsWith('report.') && key.endsWith(`.${moduleKey === 'report_summary' ? 'summary' : 'detail'}.${action}`));
  const key = modulePermissionKey(moduleKey, action); return Boolean(key && profile.permissionKeys.includes(key));
};
const accountVisibilityFor = employeeKey => permissionProfileFor(employeeKey).accountVisibility;
const accountNameForVisibility = (name, visibility) => visibility === 'full' ? name : String(name || '').split(/[-—－]/)[0].trim();
const detailPreferenceFor = employeeKey => {
  const profile = permissionProfileFor(employeeKey); return { showDirection: profile.showDirection, showFullEntry: profile.showFullEntry };
};
const matchesPeriod = (period, from, to) => period >= from && period <= to;
const hasReport = (employeeKey, reportType, level, action, companyKey, period) => hasPermissionKey(employeeKey, `report.${reportType}.${level}.${action}`, companyKey, period);
const hasAnalysis = (employeeKey, analysisKey, companyKey, period) => hasPermissionKey(employeeKey, `module.${analysisKey}.view`, companyKey, period);
const analysisBlockAccessFor = (employeeKey, companyKey, period) => Object.fromEntries(Object.entries(analysisBlockPermissionDefinitions).map(([pageKey, definition]) => [pageKey,
  Object.fromEntries(Object.keys(definition.blocks).map(blockKey => [blockKey, hasAnalysis(employeeKey, pageKey, companyKey, period) && hasPermissionKey(employeeKey, analysisBlockPermissionKey(pageKey, blockKey), companyKey, period)]))
]));
const moduleNames = new Map([
  ['home', '首页'], [financialBriefModuleKey, '财务数据简报'], ['uploads', '上传报表'], ['cash_analysis', '资产净额分析'], ['main_business_analysis', '主营业务分析'], ['expense_analysis', '费用分析'], ['group_profit_analysis', '集团合并利润趋势图'], [consultantRoiModuleKey, '顾问投入产出比'], [intercompanyModuleKey, '各公司往来校验'], [activityLogModuleKey, '浏览日志'], ['permissions', '权限管理'], ['database_admin', '数据库管理']
]);
const visibleModulesFor = (employeeKey, companyKey, period) => {
  const reportNames = new Map(db.prepare('SELECT report_type AS key, report_name AS name FROM report_types').all().map(row => [row.key, row.name]));
  const canManage = hasModule(employeeKey, 'permission_admin', 'manage');
  const canManageReportData = hasModule(employeeKey, 'database_admin', 'view');
  const canUpload = hasModule(employeeKey, 'report_import', 'upload');
  const hasDataScope = authorizedCompaniesFor(employeeKey).length > 0;
  const visible = new Set();
  for (const type of reportNames.keys()) {
    const groupScopeMatches = companyKey === 'group' ? groupOnlyReportTypes.has(type) : !groupOnlyReportTypes.has(type);
    if (groupScopeMatches && hasModule(employeeKey, 'report_summary', 'view') && hasReport(employeeKey, type, 'summary', 'view', companyKey, period)) visible.add(type);
  }
  if (canUpload && hasDataScope) visible.add('uploads');
  if (hasAnalysis(employeeKey, financialBriefModuleKey, companyKey, period)) visible.add(financialBriefModuleKey);
  if (companyKey !== 'group' && hasAnalysis(employeeKey, 'cash_analysis', companyKey, period)) visible.add('cash_analysis');
  if (companyKey !== 'group' && hasAnalysis(employeeKey, 'main_business_analysis', companyKey, period)) visible.add('main_business_analysis');
  if (companyKey !== 'group' && hasAnalysis(employeeKey, 'expense_analysis', companyKey, period)) visible.add('expense_analysis');
  if (companyKey === 'group' && hasAnalysis(employeeKey, 'group_profit_analysis', companyKey, period) && hasReport(employeeKey, 'consolidated_income_statement', 'summary', 'view', companyKey, period)) visible.add('group_profit_analysis');
  if (companyKey === 'group' && hasAnalysis(employeeKey, consultantRoiModuleKey, companyKey, period)) visible.add(consultantRoiModuleKey);
  if (companyKey === 'group' && hasAnalysis(employeeKey, intercompanyModuleKey, companyKey, period)) visible.add(intercompanyModuleKey);
  if (canManage) { visible.add(activityLogModuleKey); visible.add('permissions'); }
  if (canManageReportData && hasDataScope) visible.add('database_admin');
  const ordered = moduleOrderFor().map(row => ({ key: row.key, name: reportNames.get(row.key) || moduleNames.get(row.key) || row.key, visible: visible.has(row.key) })).filter(row => row.visible);
  return [{ key: 'home', name: '首页', visible: true }, ...ordered];
};
const availablePeriodsByCompanyFor = employeeKey => {
  const profile = permissionProfileFor(employeeKey);
  const permissionKeys = new Set(profile.permissionKeys);
  const result = Object.fromEntries(authorizedCompaniesFor(employeeKey).map(company => [company.key, []]));
  const rows = db.prepare("SELECT DISTINCT company_key AS companyKey, period, report_type AS reportType FROM report_snapshots WHERE status = 'published' AND snapshot_key LIKE '%-upload-%' ORDER BY period DESC").all();
  for (const row of rows) {
    if (!Object.hasOwn(result, row.companyKey) || !profileScopeAllows(profile, row.companyKey, row.period)) continue;
    const canViewReport = permissionKeys.has(`report.${row.reportType}.summary.view`);
    if (canViewReport && !result[row.companyKey].includes(row.period)) result[row.companyKey].push(row.period);
  }
  return result;
};
const requireEmployee = (req, res) => { const employee = employeeFrom(req); if (!employee) { json(res, 401, { error: '请先通过小Q企业微信登录', loginUrl: authMode === 'platform' ? platformLoginUrl : '' }); return null; } return employee; };
const requireReport = (req, res, reportType, level, action, companyKey, period) => { const employee = requireEmployee(req, res); if (!employee) return null; const moduleKey = level === 'summary' ? 'report_summary' : 'report_detail'; if (!hasModule(employee.employee_key, moduleKey, action) || !hasReport(employee.employee_key, reportType, level, action, companyKey, period)) { bad(res, 403, '当前员工没有该报表层级或数据范围权限'); return null; } return employee; };
const log = (employeeKey, action, target, detail, context = {}) => {
  const logType = context.logType || (action === 'browse_page' || action.startsWith('view_') ? 'browse' : 'operation');
  return db.prepare('INSERT INTO audit_logs(employee_key, action, target, detail, log_type, module_key, company_key, period, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    employeeKey, action, target, detail, logType, String(context.moduleKey || ''), String(context.companyKey || ''), String(context.period || ''), now()
  );
};
const auditActionNames = new Map([
  ['browse_page', '浏览页面'], ['platform_login', '登录财务看板'], ['view_report', '浏览报表'], ['view_raw_report', '浏览原始报表'], ['export_report', '导出报表'],
  ['view_financial_brief', '浏览财务数据简报'], ['view_asset_liability_analysis', '浏览资产负债分析'], ['view_group_profit_analysis', '浏览集团利润趋势'], ['view_consultant_roi_analysis', '浏览顾问投入产出'],
  ['view_intercompany_reconciliation', '浏览公司往来校验'], ['view_intercompany_pair', '查看往来组合'], ['view_intercompany_unmapped', '查看待映射往来'],
  ['view_cash_flow_analysis', '浏览资产净额分析'], ['view_main_business_analysis', '浏览主营业务分析'], ['view_expense_analysis', '浏览费用分析'],
  ['upload_report', '上传报表'], ['validate_upload', '校验上传批次'], ['publish_upload', '发布报表版本'], ['withdraw_published_upload', '撤回已发布版本'],
  ['restore_previous_upload', '恢复上一版本'], ['delete_unpublished_upload', '删除未发布批次'], ['create_company', '新增公司'],
  ['set_company_order', '调整公司顺序'], ['set_module_order', '调整模块顺序'], ['set_analysis_block_order', '调整分析布局'], ['set_report_watermark', '修改员工水印'],
  ['sync_platform_directory', '同步成员目录'], ['assign_role', '分配角色'], ['save_employee_permission_profile', '保存员工权限'],
  ['copy_employee_permissions', '复制员工权限'], ['remove_employee_permissions', '移除员工授权'], ['set_account_visibility', '修改科目显示'],
  ['set_detail_preference', '修改明细偏好'], ['create_financial_brief_note', '新增简报备注'], ['update_financial_brief_note', '修改简报备注'], ['delete_financial_brief_note', '删除简报备注'],
  ['create_financial_brief_item', '新增简报二级项目'], ['update_financial_brief_item', '修改简报二级项目'], ['delete_financial_brief_item', '删除简报二级项目'], ['delete_activity_logs', '删除日志']
]);
const auditActionName = action => auditActionNames.get(action) || action;
const activityLogWhere = filters => {
  const clauses = ['1 = 1']; const args = [];
  for (const [value, column] of [[filters.employeeKey, 'a.employee_key'], [filters.logType, 'a.log_type'], [filters.action, 'a.action'], [filters.moduleKey, 'a.module_key'], [filters.companyKey, 'a.company_key'], [filters.period, 'a.period']]) {
    if (value) { clauses.push(`${column} = ?`); args.push(value); }
  }
  if (filters.startAt) { clauses.push('a.created_at >= ?'); args.push(filters.startAt); }
  if (filters.endAt) { clauses.push('a.created_at < ?'); args.push(filters.endAt); }
  if (filters.search) {
    const like = `%${filters.search}%`;
    clauses.push('(e.display_name LIKE ? OR e.department LIKE ? OR a.action LIKE ? OR a.target LIKE ? OR a.detail LIKE ?)');
    args.push(like, like, like, like, like);
  }
  return { sql: clauses.join(' AND '), args };
};

const reportTypeRow = reportType => db.prepare('SELECT * FROM report_types WHERE report_type = ?').get(reportType);
const companyRow = companyKey => db.prepare('SELECT * FROM companies WHERE company_key = ?').get(companyKey);
const snapshotFor = (companyKey, period, reportType, version) => version
  ? db.prepare("SELECT * FROM report_snapshots WHERE company_key = ? AND period = ? AND report_type = ? AND version = ? AND snapshot_key LIKE '%-upload-%'").get(companyKey, period, reportType, Number(version))
  : db.prepare("SELECT * FROM report_snapshots WHERE company_key = ? AND period = ? AND report_type = ? AND status = 'published' AND snapshot_key LIKE '%-upload-%' ORDER BY version DESC LIMIT 1").get(companyKey, period, reportType);
const detailKeyMap = {
  balance_sheet: { cash: ['1', '4'], receivable: ['2', '5'], fixed: ['3'], payable: ['4'], equity: ['5'] },
  income_statement: { admin: ['1', '6'], selling: ['2'], cost: ['3'], receivable: ['4'], revenue: ['5'] },
  cash_flow: { operating: ['1', '5'], investing: ['2'], financing: ['3'], closing: ['4'] }
};
const isProfitClosingSummary = value => /结转\s*损益|损益\s*结转|结转\s*本年利润|期末\s*结转/.test(String(value ?? ''));
const withoutProfitClosingEntries = (rows, summaryFor, voucherFor) => {
  const closingVouchers = new Set(rows.filter(row => isProfitClosingSummary(summaryFor(row))).map(row => String(voucherFor(row) ?? '').trim()).filter(Boolean));
  return rows.filter(row => !isProfitClosingSummary(summaryFor(row)) && !closingVouchers.has(String(voucherFor(row) ?? '').trim()));
};
const detailRowsFor = (snapshotKey, reportType, lineCode = '', search = '', showFullEntry = false) => {
  const allRows = db.prepare('SELECT detail_key, entry_date AS date, voucher_no AS voucher, account_code AS accountCode, account_name AS account, summary, debit, credit, balance FROM report_details WHERE snapshot_key = ? ORDER BY entry_date, detail_key').all(snapshotKey);
  const rows = reportType === 'income_statement' ? withoutProfitClosingEntries(allRows, row => row.summary, row => row.voucher) : allRows;
  const keys = detailKeyMap[reportType]?.[lineCode];
  const scoped = keys ? rows.filter(row => keys.includes(row.detail_key)) : rows;
  const matched = search ? scoped.filter(row => [row.account, row.accountCode].some(value => String(value || '').includes(search))) : scoped;
  const fallback = search && !matched.length ? scoped.filter(row => String(row.summary || '').includes(search)) : matched;
  const vouchers = new Set(fallback.map(row => row.voucher).filter(Boolean));
  const filtered = showFullEntry && search && vouchers.size ? rows.filter(row => vouchers.has(row.voucher)) : fallback;
  return filtered.map(({ detail_key, ...row }) => row);
};
const rawDetailSearchTokens = (reportType, search) => {
  const normalized = String(search || '')
    .replace(/^\s*[一二三四五六七八九十]+、\s*/, '')
    .replace(/^(?:减|加|其中)[：:]\s*/, '')
    .replace(/[（(].*$/, '')
    .trim();
  const aliases = {
    income_statement: {
      '营业收入': ['主营业务收入'],
      '营业成本': ['主营业务成本']
    }
  };
  const totalAccounts = ['主营业务收入', '主营业务成本', '税金及附加', '销售费用', '管理费用', '财务费用', '营业外收入', '营业外支出', '所得税费用'];
  const totalTokens = reportType === 'income_statement' && ['营业利润', '利润总额', '净利润'].includes(normalized) ? totalAccounts : [];
  return [...new Set([search, normalized, ...(aliases[reportType]?.[normalized] || []), ...totalTokens].filter(Boolean))];
};
const rawRowsFor = (reportType, companyKey, period, search, employeeKey = 'admin', showFullEntry = true, accountCodes = []) => {
  // 报表金额的下钻事实源始终是同公司、同期间的已发布序时账。
  // 独立上传报表时，各批次路径只包含自身工作表，不能用利润表路径代替序时账。
  const journalUploads = db.prepare("SELECT raw_path, report_type FROM upload_batches WHERE company_key = ? AND period = ? AND status = 'published' ORDER BY CASE WHEN report_type = 'journal' THEN 0 ELSE 1 END, published_at DESC").all(companyKey, period);
  let raw = { rows: [] };
  for (const upload of journalUploads) {
    if (!upload?.raw_path || !fs.existsSync(upload.raw_path)) continue;
    try {
      const all = JSON.parse(fs.readFileSync(upload.raw_path, 'utf8'));
      const candidate = all.journal || all.uploaded?.journal || (upload.report_type === 'journal' ? all : null);
      if (candidate?.rows?.length) { raw = candidate; break; }
    } catch {}
  }
  const tokens = rawDetailSearchTokens(reportType, search);
  const visibility = accountVisibilityFor(employeeKey);
  const allRows = raw?.rows || [];
  const rows = reportType === 'income_statement'
    ? withoutProfitClosingEntries(allRows, row => row.cells?.[2], row => row.cells?.[1])
    : allRows;
  const wantedCodes = new Set(accountCodes.map(value => String(value || '').trim()).filter(Boolean));
  const codeMatches = wantedCodes.size ? rows.filter(row => wantedCodes.has(String(row.cells?.[3] ?? '').trim())) : [];
  const accountMatches = wantedCodes.size ? [] : rows.filter(row => tokens.some(token => String(row.cells?.[4] ?? '').includes(token)));
  const matched = wantedCodes.size ? codeMatches : (accountMatches.length ? accountMatches : rows.filter(row => tokens.some(token => (row.cells || []).some(value => String(value ?? '').includes(token)))));
  const vouchers = new Set(matched.map(row => String(row.cells?.[1] ?? '')).filter(Boolean));
  const selected = showFullEntry && vouchers.size ? rows.filter(row => vouchers.has(String(row.cells?.[1] ?? ''))) : matched;
  return selected.slice(0, 100).map(row => ({ ...row, cells: (row.cells || []).map((value, index) => index === 4 ? accountNameForVisibility(value, visibility) : value) }));
};

const cashFlowProjectGroups = {
  '经营活动现金流入小计': ['销售商品、提供劳务收到的现金', '收到的税费返还', '收到其他与经营活动有关的现金'],
  '经营活动现金流出小计': ['购买商品、接受劳务支付的现金', '支付给职工及为职工支付的现金', '支付的各项税费', '支付其他与经营活动有关的现金'],
  '投资活动现金流入小计': ['收回投资收到的现金', '取得投资收益收到的现金', '处置固定资产、无形资产和其他长期资产收回的现金净额', '处置子公司及其他营业单位收到的现金净额', '收到其他与投资活动有关的现金'],
  '投资活动现金流出小计': ['购建固定资产、无形资产和其他长期资产支付的现金', '投资支付的现金', '取得子公司及其他营业单位支付的现金净额', '支付其他与投资活动有关的现金'],
  '筹资活动现金流入小计': ['吸收投资收到的现金', '取得借款收到的现金', '收到其他与筹资活动有关的现金'],
  '筹资活动现金流出小计': ['偿还债务支付的现金', '分配股利、利润或偿付利息支付的现金', '支付其他与筹资活动有关的现金']
};
cashFlowProjectGroups['经营活动产生的现金流量净额'] = [...cashFlowProjectGroups['经营活动现金流入小计'], ...cashFlowProjectGroups['经营活动现金流出小计']];
cashFlowProjectGroups['投资活动产生的现金流量净额'] = [...cashFlowProjectGroups['投资活动现金流入小计'], ...cashFlowProjectGroups['投资活动现金流出小计']];
cashFlowProjectGroups['筹资活动产生的现金流量净额'] = [...cashFlowProjectGroups['筹资活动现金流入小计'], ...cashFlowProjectGroups['筹资活动现金流出小计']];
const excelDateText = value => {
  if (typeof value === 'number' && value > 30000) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  return String(value ?? '').slice(0, 10);
};
const cashFlowWorkpaperFor = (companyKey, period, search) => {
  const upload = db.prepare("SELECT file_name, file_type, storage_path, raw_path FROM upload_batches WHERE company_key = ? AND period = ? AND report_type = 'cash_flow' AND status = 'published' ORDER BY published_at DESC LIMIT 1").get(companyKey, period);
  let workpaper = null;
  if (upload?.raw_path && fs.existsSync(upload.raw_path)) {
    try { workpaper = JSON.parse(fs.readFileSync(upload.raw_path, 'utf8')).cash_flow_workpaper || null; } catch {}
  }
  if (!workpaper && upload?.storage_path && fs.existsSync(upload.storage_path)) {
    try { workpaper = parseUploadedFile(fs.readFileSync(upload.storage_path), upload.file_name, upload.file_type).cash_flow_workpaper || null; } catch {}
  }
  const normalized = String(search || '').replace(/^\s*[一二三四五六七八九十]+、\s*/, '').replace(/^(?:加|减|其中)[：:]\s*/, '').trim();
  const allProjects = Object.values(cashFlowProjectGroups).flat();
  const wanted = ['现金及现金等价物净增加额', '期末现金及现金等价物余额'].includes(normalized)
    ? [...new Set(allProjects)]
    : (cashFlowProjectGroups[normalized] || [normalized]);
  const header = (workpaper?.rows || []).find(row => (row.cells || []).some(value => String(value || '').trim() === '现金流量表项目'))?.cells || [];
  const column = (name, fallback) => { const index = header.findIndex(value => String(value || '').trim() === name); return index >= 0 ? index : fallback; };
  const dateIndex = column('日期', 0); const voucherIndex = column('凭证号', 1); const summaryIndex = column('摘要', 2); const accountIndex = column('科目名称', 4); const debitIndex = column('借方金额', 5); const creditIndex = column('贷方金额', 6); const projectIndex = column('现金流量表项目', 20); const noteIndex = Math.max(0, projectIndex - 1); const ruleIndex = projectIndex + 1;
  const rows = (workpaper?.rows || []).filter(row => row.row !== 1 && wanted.includes(String(row.cells?.[projectIndex] || '').trim())).map(row => {
    const cells = row.cells || [];
    return { row: row.row, date: excelDateText(cells[dateIndex]), voucher: cells[voucherIndex], summary: cells[summaryIndex], account: cells[accountIndex], debit: Number(cells[debitIndex] || 0), credit: Number(cells[creditIndex] || 0), note: cells[noteIndex], project: String(cells[projectIndex] || '').trim(), rule: cells[ruleIndex] };
  });
  return { sourceSheet: workpaper?.sourceSheet || '现金流量表底稿', rows: rows.slice(0, 200) };
};
const sourceDetailFor = (reportType, companyKey, period, search, employeeKey, showFullEntry, accountCodes = []) => {
  if (reportType === 'cash_flow') {
    const workpaper = cashFlowWorkpaperFor(companyKey, period, search);
    return { detailKind: 'cash_flow_workpaper', detailSourceSheet: workpaper.sourceSheet, workpaperRows: workpaper.rows, rawRows: [] };
  }
  return { detailKind: 'journal', rawRows: rawRowsFor(reportType, companyKey, period, search, employeeKey, showFullEntry, accountCodes), workpaperRows: [] };
};

const rawReportFor = (reportType, companyKey, period) => {
  const upload = db.prepare("SELECT upload_key, file_name, raw_path, status, created_at, published_at FROM upload_batches WHERE company_key = ? AND period = ? AND report_type = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1").get(companyKey, period, reportType);
  if (upload?.raw_path && fs.existsSync(upload.raw_path)) {
    try {
      const reports = JSON.parse(fs.readFileSync(upload.raw_path, 'utf8'));
      return { raw: reports[reportType] || reports.uploaded?.[reportType] || reports, meta: { demo: false, uploadKey: upload.upload_key, fileName: upload.file_name, status: upload.status, createdAt: upload.created_at, publishedAt: upload.published_at } };
    } catch {}
  }
  return { raw: { sourceSheet: '暂无已上传数据', maxRow: 0, maxCol: 0, rows: [] }, meta: { demo: false, noData: true, uploadKey: null, fileName: '暂无已上传数据', status: 'missing' } };
};

const previousPeriod = period => {
  const match = String(period || '').match(/^(\d{4})-(\d{2})$/); if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};
const journalDateFor = row => String(row?.cells?.[0] ?? '').slice(0, 10);
const amountFor = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const normalized = String(value ?? '').replace(/,/g, '').replace(/[￥¥\s]/g, '');
  const amount = Number(normalized); return Number.isFinite(amount) ? amount : 0;
};
const journalColumnIndex = (raw, name, fallback) => {
  const header = (raw?.rows || []).find(row => (row?.cells || []).some(value => String(value ?? '').trim() === '科目名称'))?.cells || [];
  const index = header.findIndex(value => String(value ?? '').trim() === name);
  return index >= 0 ? index : fallback;
};
const extractContractNo = (row, columns = {}) => {
  const cells = row?.cells || [];
  const source = [cells[columns.summary ?? 2], cells[columns.note ?? 19], cells[columns.projectName ?? 15]].map(value => String(value ?? '')).join(' ');
  return source.match(/20\d{6}-\d{4}/)?.[0] || null;
};
const accountingOperatorLabel = value => /^会计\s*\d+$/i.test(String(value ?? '').trim());
const explicitCustomerNameForJournalRow = (row, columns = {}) => String(row?.cells?.[columns.customerName ?? 8] ?? '').trim();
const projectIndexInSummary = (text, projectName) => {
  const direct = text.indexOf(projectName); if (direct >= 0) return direct;
  const ignored = /[\s\-—－_/]/; const normalizedChars = []; const positions = [];
  [...text].forEach((character, index) => { if (!ignored.test(character)) { normalizedChars.push(character); positions.push(index); } });
  const normalizedProject = [...projectName].filter(character => !ignored.test(character)).join('');
  const normalizedIndex = normalizedChars.join('').indexOf(normalizedProject);
  if (normalizedIndex >= 0) return positions[normalizedIndex];
  const latinAnchor = projectName.match(/[A-Za-z]{3,}/)?.[0];
  return latinAnchor ? text.toLowerCase().indexOf(latinAnchor.toLowerCase()) : -1;
};
const customerNameFromSummary = (row, contractNo, projectName, columns = {}) => {
  if (!contractNo || !projectName || projectName === '未分类项目') return '';
  const summary = String(row?.cells?.[columns.summary ?? 2] ?? '').trim();
  const contractIndex = summary.indexOf(contractNo); if (contractIndex < 0) return '';
  const remainder = summary.slice(contractIndex + contractNo.length).replace(/^[\s:：,，;；_—-]+/, '');
  const projectIndex = projectIndexInSummary(remainder, projectName); if (projectIndex <= 0) return '';
  const candidate = remainder.slice(0, projectIndex).replace(/^(?:客户|学员)\s*[:：]?\s*/, '').replace(/[\s:：,，;；_—-]+$/, '').replace(/(?:办理|申请|确认|支付|签约|缴纳|购买)+$/, '').trim();
  if (candidate.length < 2 || candidate.length > 24 || /申请|支付|确认|结转|成本|收入|服务费|银行/.test(candidate)) return '';
  return candidate;
};
const projectNameForJournalRow = (row, contractProjects = new Map(), columns = {}, contractOverride = null) => {
  const cells = row?.cells || [];
  const contractNo = contractOverride || extractContractNo(row, columns);
  const explicit = String(cells[columns.projectName ?? 15] ?? '').trim();
  if (explicit && !accountingOperatorLabel(explicit)) return explicit;
  if (contractNo && contractProjects.has(contractNo) && /^主营业务成本-(?:返佣|其他|杂费)/.test(String(cells[4] || ''))) return contractProjects.get(contractNo);
  const account = String(cells[4] ?? '').trim();
  const accountProject = account.replace(/^主营业务(?:收入|成本)-?/, '').trim();
  return accountProject && !accountingOperatorLabel(accountProject) ? accountProject : '未分类项目';
};
const mainBusinessRowsFromRaw = (raw, period) => {
  const rows = (raw?.rows || []).filter(row => row?.row !== 1 && Array.isArray(row?.cells));
  const businessRows = rows.filter(row => /^(主营业务收入|主营业务成本)-/.test(String(row.cells?.[4] ?? '')));
  const columns = {
    summary: journalColumnIndex(raw, '摘要', 2),
    customerName: journalColumnIndex(raw, '客户名称', 8),
    projectName: journalColumnIndex(raw, '项目名称', 15),
    note: journalColumnIndex(raw, '备注', 19)
  };
  const voucherKey = row => {
    const voucher = String(row?.cells?.[1] ?? '').trim();
    return voucher ? `${journalDateFor(row)}|${voucher}` : '';
  };
  const voucherContractSets = new Map();
  rows.forEach(row => {
    const key = voucherKey(row); const contract = extractContractNo(row, columns);
    if (!key || !contract) return;
    if (!voucherContractSets.has(key)) voucherContractSets.set(key, new Set());
    voucherContractSets.get(key).add(contract);
  });
  const voucherContracts = new Map([...voucherContractSets.entries()].filter(([, contracts]) => contracts.size === 1).map(([key, contracts]) => [key, [...contracts][0]]));
  const contractForRow = row => extractContractNo(row, columns) || voucherContracts.get(voucherKey(row)) || null;
  const revenueProjects = new Map();
  businessRows.filter(row => String(row.cells?.[4] ?? '').startsWith('主营业务收入-')).forEach(row => {
    const contract = contractForRow(row); if (contract && !revenueProjects.has(contract)) revenueProjects.set(contract, projectNameForJournalRow(row, new Map(), columns, contract));
  });
  const contractCustomers = new Map();
  rows.forEach(row => {
    const contract = contractForRow(row); const customerName = explicitCustomerNameForJournalRow(row, columns);
    if (contract && customerName && !contractCustomers.has(contract)) contractCustomers.set(contract, customerName);
  });
  businessRows.filter(row => String(row.cells?.[4] ?? '').startsWith('主营业务收入-')).forEach(row => {
    const contract = contractForRow(row); if (!contract || contractCustomers.has(contract)) return;
    const projectName = projectNameForJournalRow(row, revenueProjects, columns, contract);
    const customerName = customerNameFromSummary(row, contract, projectName, columns);
    if (customerName) contractCustomers.set(contract, customerName);
  });
  const normalized = businessRows.map(row => {
    const account = String(row.cells?.[4] ?? ''); const contractNo = contractForRow(row);
    const kind = account.startsWith('主营业务收入-') ? 'revenue' : 'cost';
    const amount = kind === 'revenue' ? Math.max(0, amountFor(row.cells?.[6])) : Math.max(0, amountFor(row.cells?.[5]));
    const periodValue = journalDateFor(row).slice(0, 7);
    const projectName = projectNameForJournalRow(row, revenueProjects, columns, contractNo);
    const customerName = explicitCustomerNameForJournalRow(row, columns) || contractCustomers.get(contractNo) || customerNameFromSummary(row, contractNo, projectName, columns) || '未识别客户';
    return { row, period: periodValue, kind, amount, contractNo, customerName, projectName, voucher: String(row.cells?.[1] ?? '').trim() };
  }).filter(item => item.amount || item.contractNo || item.projectName);
  return { rows: normalized, sourceRows: rows, revenueProjects };
};
const roundedAmount = value => Math.round(Number(value || 0) * 100) / 100;
const mainBusinessAnalysisFor = (companyKey, period, year = String(period || '').slice(0, 4)) => {
  const source = rawReportFor('journal', companyKey, period);
  const prior = previousPeriod(period);
  const periodRows = new Map();
  const rowsForPeriod = targetPeriod => {
    if (!periodRows.has(targetPeriod)) {
      const periodSource = targetPeriod === period ? source : rawReportFor('journal', companyKey, targetPeriod);
      const parsed = mainBusinessRowsFromRaw(periodSource.raw, targetPeriod);
      periodRows.set(targetPeriod, { source: periodSource, parsed, rows: parsed.rows.filter(item => item.period === targetPeriod) });
    }
    return periodRows.get(targetPeriod);
  };
  const currentData = rowsForPeriod(period); const currentRows = currentData.rows;
  const previousRows = rowsForPeriod(prior).rows;
  const warnings = [];
  const unknownRows = currentRows.filter(item => !item.contractNo && item.amount > 0);
  if (unknownRows.length) warnings.push(`${unknownRows.length} 条主营业务分录未识别合同编号，已按项目和凭证归类`);
  if (!currentRows.length) warnings.push(`当前期间 ${period} 未找到主营业务收入或成本分录`);
  const aggregate = rows => {
    const map = new Map();
    rows.forEach(item => {
      const contractNo = item.contractNo || `未识别合同-${item.voucher || item.row.row}`;
      const key = `${contractNo}|${item.projectName}`;
      const value = map.get(key) || { contractNo: item.contractNo || '未识别合同', customerName: item.customerName || '未识别客户', projectName: item.projectName, revenue: 0, cost: 0, identity: contractNo };
      if (value.customerName === '未识别客户' && item.customerName && item.customerName !== '未识别客户') value.customerName = item.customerName;
      value[item.kind] += item.amount; map.set(key, value);
    });
    return [...map.values()];
  };
  const detailRows = aggregate(currentRows).filter(row => row.revenue || row.cost).sort((a, b) => b.revenue - a.revenue || b.cost - a.cost || a.projectName.localeCompare(b.projectName, 'zh-CN')).map((row, index) => ({
    index: index + 1, contractNo: row.contractNo, customerName: row.customerName, projectName: row.projectName, revenue: roundedAmount(row.revenue), cost: roundedAmount(row.cost), grossProfit: roundedAmount(row.revenue - row.cost), grossMargin: row.revenue ? roundedAmount((row.revenue - row.cost) / row.revenue * 100) : null
  }));
  const countByProject = rows => {
    const map = new Map(); rows.forEach(item => { const name = item.projectName; const id = item.contractNo || `未识别合同-${item.voucher || item.row.row}`; if (!map.has(name)) map.set(name, new Set()); map.get(name).add(id); }); return map;
  };
  const currentCounts = countByProject(currentRows.filter(item => item.amount > 0)); const previousCounts = countByProject(previousRows.filter(item => item.amount > 0));
  const projects = [...new Set([...currentCounts.keys(), ...previousCounts.keys()])];
  const projectRows = projects.map(projectName => {
    const currentProjectCount = currentCounts.get(projectName)?.size || 0; const previousProjectCount = previousCounts.get(projectName)?.size || 0;
    return { projectName, currentProjectCount, previousProjectCount, changeRate: previousProjectCount ? roundedAmount((currentProjectCount - previousProjectCount) / previousProjectCount * 100) : null };
  }).sort((a, b) => b.currentProjectCount - a.currentProjectCount || b.previousProjectCount - a.previousProjectCount || a.projectName.localeCompare(b.projectName, 'zh-CN'));
  const monthly = Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${String(index + 1).padStart(2, '0')}`; const rows = rowsForPeriod(month).rows;
    const revenue = roundedAmount(rows.filter(item => item.kind === 'revenue').reduce((sum, item) => sum + item.amount, 0)); const cost = roundedAmount(rows.filter(item => item.kind === 'cost').reduce((sum, item) => sum + item.amount, 0));
    return { month, revenue, cost, grossProfit: roundedAmount(revenue - cost) };
  });
  return { analysis: 'main_business', company: companyRow(companyKey)?.company_name || companyKey, period, previousPeriod: prior, year, current: { revenue: roundedAmount(currentRows.filter(item => item.kind === 'revenue').reduce((sum, item) => sum + item.amount, 0)), cost: roundedAmount(currentRows.filter(item => item.kind === 'cost').reduce((sum, item) => sum + item.amount, 0)), projectCount: detailRows.length }, detailRows, projectRows, monthlyTrend: monthly, source: { ...source.meta, sourceSheet: source.raw?.sourceSheet || '—' }, warnings };
};

const expensePeriodRows = (raw, targetPeriod) => (raw?.rows || []).filter(row => {
  const cells = row?.cells || []; const date = journalDateFor(row); const account = String(cells[4] || '').trim();
  return row?.row !== 1 && Array.isArray(cells) && (!targetPeriod || date.slice(0, 7) === targetPeriod) && /^(销售费用|管理费用|财务费用)(?:[-—－]|$)/.test(account);
}).map(row => {
  const cells = row.cells || []; const account = String(cells[4] || '').trim(); const debit = amountFor(cells[5]); const credit = amountFor(cells[6]);
  const category = account.split(/[-—－]/)[0]; const secondLevel = (account.replace(/^(销售费用|管理费用|财务费用)[-—－]?/, '').trim().split(/[-—－]/)[0] || '未分类').trim();
  return { row, date: journalDateFor(row), period: journalDateFor(row).slice(0, 7), account, category, secondLevel, summary: String(cells[2] || '').trim(), debit, credit, amount: debit, voucher: String(cells[1] || '').trim() };
});

const expenseRowsForPeriod = (companyKey, period) => expensePeriodRows(rawReportFor('journal', companyKey, period).raw, period);
const expenseCategoryFor = (rows, category) => {
  const grouped = new Map(); rows.filter(row => row.category === category).forEach(row => grouped.set(row.secondLevel, (grouped.get(row.secondLevel) || 0) + row.amount));
  return [...grouped.entries()].map(([name, amount]) => ({ name, amount: roundedAmount(amount) })).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'zh-CN'));
};
const expenseMonthlyFor = (companyKey, year, category) => Array.from({ length: 12 }, (_, index) => {
  const month = `${year}-${String(index + 1).padStart(2, '0')}`; const rows = expenseRowsForPeriod(companyKey, month); return { month, amount: roundedAmount(rows.filter(row => row.category === category).reduce((sum, row) => sum + row.amount, 0)) };
});
const expenseRate = (current, prior) => prior ? roundedAmount((current - prior) / Math.abs(prior) * 100) : (current ? null : 0);
const paymentMethodFor = summary => {
  const text = String(summary || '').replace(/\s+/g, '');
  if (/通联|扫码|聚合码|收款码/.test(text)) return '通联扫码';
  if (/富友/.test(text)) return '富友';
  if (/财付通|微信支付|微信/.test(text)) return '财付通';
  return '银行转账';
};
const expenseAnalysisFor = (companyKey, period, year = String(period || '').slice(0, 4)) => {
  const prior = previousPeriod(period); const currentRows = expenseRowsForPeriod(companyKey, period); const priorRows = expenseRowsForPeriod(companyKey, prior);
  const buildSection = category => {
    const current = expenseCategoryFor(currentRows, category); const previous = new Map(expenseCategoryFor(priorRows, category).map(item => [item.name, item.amount]));
    const detailsFor = (sourceRows, name) => sourceRows.filter(row => row.category === category && row.secondLevel === name && Math.abs(row.amount) > 0.000001 && !/结转损益|损益结转|结转本年利润|期末结转/.test(row.summary)).map(row => ({ row: row.row?.row || row.row, period: row.period, date: row.date, voucher: row.voucher, summary: row.summary, account: row.account, debit: row.debit, credit: row.credit, amount: row.amount, kind: '费用借方发生额' }));
    const rows = current.map(item => ({ name: item.name, current: item.amount, prior: previous.get(item.name) || 0, changeRate: expenseRate(item.amount, previous.get(item.name) || 0), currentDetails: detailsFor(currentRows, item.name), priorDetails: detailsFor(priorRows, item.name) }));
    previous.forEach((amount, name) => { if (!rows.some(item => item.name === name)) rows.push({ name, current: 0, prior: amount, changeRate: expenseRate(0, amount), currentDetails: [], priorDetails: detailsFor(priorRows, name) }); });
    rows.sort((a, b) => b.current - a.current || b.prior - a.prior || a.name.localeCompare(b.name, 'zh-CN'));
    const total = rows.reduce((sum, item) => sum + item.current, 0); rows.forEach(item => { item.share = total ? roundedAmount(item.current / total * 100) : 0; });
    return { rows, total: roundedAmount(total), monthly: expenseMonthlyFor(companyKey, year, category), source: rawReportFor('journal', companyKey, period).meta };
  };
  const financeRowsFor = source => {
    const rows = source?.rows || []; return rows.filter(row => row?.row !== 1 && Array.isArray(row?.cells)).map(row => { const cells = row.cells || []; const account = String(cells[4] || '').trim(); const summary = String(cells[2] || '').trim(); return { row: row.row, date: journalDateFor(row), period: journalDateFor(row).slice(0, 7), voucher: String(cells[1] || '').trim(), account, summary, method: paymentMethodFor(summary), debit: amountFor(cells[5]), credit: amountFor(cells[6]), income: /银行存款/.test(account) ? Math.max(0, amountFor(cells[5]) - amountFor(cells[6])) : 0, fee: /^财务费用(?:[-—－]|$)/.test(account) ? amountFor(cells[5]) : 0 }; }).filter(row => row.income || row.fee); };
  const financeDetail = (row, kind) => ({ row: row.row, period: row.period, date: row.date, voucher: row.voucher, summary: row.summary, account: row.account, debit: row.debit, credit: row.credit, amount: kind === 'fee' ? row.fee : row.income, kind: kind === 'fee' ? '手续费' : '银行存款收入' });
  const financeCurrent = financeRowsFor(rawReportFor('journal', companyKey, period).raw).filter(row => row.period === period); const financePrior = financeRowsFor(rawReportFor('journal', companyKey, prior).raw).filter(row => row.period === prior);
  const finance = ['银行转账', '通联扫码', '富友', '财付通'].map(method => {
    const currentAmount = financeCurrent.filter(row => row.method === method).reduce((sum, row) => sum + row.income, 0); const priorAmount = financePrior.filter(row => row.method === method).reduce((sum, row) => sum + row.income, 0);
    const fee = financeCurrent.filter(row => row.method === method).reduce((sum, row) => sum + row.fee, 0); const feePrior = financePrior.filter(row => row.method === method).reduce((sum, row) => sum + row.fee, 0);
    return { method, current: roundedAmount(currentAmount), prior: roundedAmount(priorAmount), changeRate: expenseRate(currentAmount, priorAmount), fee: roundedAmount(fee), feePrior: roundedAmount(feePrior), feeRate: currentAmount ? roundedAmount(fee / currentAmount * 100) : 0, currentDetails: financeCurrent.filter(row => row.method === method && row.income).map(row => financeDetail(row, 'income')), priorDetails: financePrior.filter(row => row.method === method && row.income).map(row => financeDetail(row, 'income')), feeDetails: financeCurrent.filter(row => row.method === method && row.fee).map(row => financeDetail(row, 'fee')), feePriorDetails: financePrior.filter(row => row.method === method && row.fee).map(row => financeDetail(row, 'fee')) };
  });
  const visibleFinance = finance.filter(row => Math.abs(row.current) > 0.000001 || Math.abs(row.prior) > 0.000001).sort((a, b) => b.current - a.current || b.prior - a.prior || a.method.localeCompare(b.method, 'zh-CN'));
  const financeTotal = visibleFinance.reduce((sum, row) => sum + row.current, 0); visibleFinance.forEach(row => { row.share = financeTotal ? roundedAmount(row.current / financeTotal * 100) : 0; });
  return { analysis: 'expense', company: companyRow(companyKey)?.company_name || companyKey, period, previousPeriod: prior, year, selling: buildSection('销售费用'), administration: buildSection('管理费用'), finance: { rows: visibleFinance, total: roundedAmount(financeTotal), feeTotal: roundedAmount(visibleFinance.reduce((sum, row) => sum + row.fee, 0)), source: rawReportFor('journal', companyKey, period).meta } };
};

const cashFlowSnapshotAnalysisFor = (companyKey, period) => {
  const source = rawReportFor('trial_balance', companyKey, period); const rows = source.raw?.rows || [];
  if (source.meta.noData) return { source: { ...source.meta, sourceSheet: source.raw.sourceSheet }, metrics: { cash: 0, internalNet: 0, customerReceivables: 0, costPayables: 0, receivablesPayablesNet: 0, staticLiquidity: 0, coreNetLiquidity: 0, operatingWorkingCapitalNet: 0 }, internalPositions: [], cashAccounts: [], otherCurrentItems: [] };
  const header = rows.find(row => (row.cells || []).some(value => String(value || '').includes('期末余额')));
  const debitIndex = Math.max(0, (header?.cells || []).findIndex(value => String(value || '').includes('期末余额'))); const endDebitIndex = debitIndex >= 2 ? debitIndex : 8; const endCreditIndex = endDebitIndex + 1;
  const normalized = rows.map(row => { const cells = row.cells || []; return { row: row.row, code: String(cells[0] || '').trim(), name: String(cells[1] || '').trim(), debit: Number(cells[endDebitIndex] || 0), credit: Number(cells[endCreditIndex] || 0) }; }).filter(row => row.code);
  const exact = code => normalized.find(row => row.code === code);
  const assetBalance = row => row ? row.debit - row.credit : 0; const liabilityBalance = row => row ? row.credit - row.debit : 0;
  const children = prefix => normalized.filter(row => row.code.startsWith(prefix) && row.code.length === 7);
  const internalParty = name => /桉侨|桉桥|安侨/.test(String(name || ''));
  const partyFullName = name => String(name || '').replace(/桉桥|安侨/g, '桉侨').replace(/\s+/g, ' ').trim();
  const partyKey = name => {
    const compact = partyFullName(name).replace(/移民咨询服务有限公司|移民服务有限公司|海外咨询服务有限公司|有限公司/g, '').replace(/\s+/g, '').trim();
    const adjusted = compact.endsWith('调整'); const base = adjusted ? compact.slice(0, -2) : compact;
    const match = base.match(/^(.+?)(?:市)?桉侨$/); const normalized = match ? `${match[1]}桉侨` : base;
    return adjusted ? `${normalized}调整` : normalized;
  };
  const receivables = children('1122'); const otherReceivables = children('1221'); const payables = children('2202'); const otherPayables = children('2241');
  const internal = new Map(); const addInternal = (row, amount, field) => { const key = partyKey(row.name); const fullName = partyFullName(row.name); const current = internal.get(key) || { party: fullName, accountCodes: [], receivable: 0, otherReceivable: 0, payable: 0, otherPayable: 0, net: 0 }; if (fullName.length > current.party.length) current.party = fullName; if (row.code && !current.accountCodes.includes(row.code)) current.accountCodes.push(row.code); current[field] += amount; current.net += field.includes('payable') || field.includes('Payable') ? -amount : amount; internal.set(key, current); };
  receivables.filter(row => internalParty(row.name)).forEach(row => addInternal(row, assetBalance(row), 'receivable'));
  otherReceivables.filter(row => internalParty(row.name)).forEach(row => addInternal(row, assetBalance(row), 'otherReceivable'));
  payables.filter(row => internalParty(row.name)).forEach(row => addInternal(row, liabilityBalance(row), 'payable'));
  otherPayables.filter(row => internalParty(row.name)).forEach(row => addInternal(row, liabilityBalance(row), 'otherPayable'));
  const internalPositions = [...internal.values()].sort((a, b) => a.party.localeCompare(b.party, 'zh-CN'));
  const cash = assetBalance(exact('1002')); const customerReceivables = receivables.filter(row => !internalParty(row.name)).reduce((sum, row) => sum + assetBalance(row), 0); const costPayables = payables.filter(row => !internalParty(row.name)).reduce((sum, row) => sum + liabilityBalance(row), 0); const internalNet = internalPositions.reduce((sum, row) => sum + row.net, 0);
  const receivablesPayablesNet = internalNet + customerReceivables - costPayables; const staticLiquidity = cash + receivablesPayablesNet; const coreNetLiquidity = cash + internalNet;
  const rounded = value => Math.round(Number(value || 0) * 100) / 100;
  return {
    source: { ...source.meta, sourceSheet: source.raw?.sourceSheet || '—' },
    metrics: { cash: rounded(cash), internalNet: rounded(internalNet), customerReceivables: rounded(customerReceivables), costPayables: rounded(costPayables), receivablesPayablesNet: rounded(receivablesPayablesNet), staticLiquidity: rounded(staticLiquidity), coreNetLiquidity: rounded(coreNetLiquidity), operatingWorkingCapitalNet: rounded(customerReceivables - costPayables) },
    internalPositions: internalPositions.map(item => Object.fromEntries(Object.entries(item).map(([key, value]) => [key, typeof value === 'number' ? rounded(value) : value]))),
    cashAccounts: children('1002').map(row => ({ code: row.code, name: row.name, balance: rounded(assetBalance(row)) })),
    otherCurrentItems: [
      { name: '预付账款', amount: rounded(assetBalance(exact('1123'))), nature: '资产' }, { name: '其他应收款', amount: rounded(assetBalance(exact('1221'))), nature: '资产' },
      { name: '预收账款', amount: rounded(liabilityBalance(exact('2203'))), nature: '负债' }, { name: '应付职工薪酬', amount: rounded(liabilityBalance(exact('2211'))), nature: '负债' }
    ]
  };
};

const cashFlowAnalysisFor = (companyKey, period, year = String(period || '').slice(0, 4)) => {
  const current = cashFlowSnapshotAnalysisFor(companyKey, period);
  if (current.source?.noData) return { ...current, year, monthlyTrend: [] };
  const monthlyTrend = Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${String(index + 1).padStart(2, '0')}`;
    const snapshot = cashFlowSnapshotAnalysisFor(companyKey, month);
    const available = !snapshot.source?.noData;
    return { month, available, coreNetLiquidity: available ? snapshot.metrics.coreNetLiquidity : null };
  });
  return { ...current, year, monthlyTrend };
};

const intercompanyTolerance = 0.01;
const intercompanyRegions = [
  ['广州', '广州'], ['深圳', '深圳'], ['成都', '成都'], ['南京', '南京'], ['长沙', '长沙'], ['青岛', '青岛'], ['北京', '北京']
];
const intercompanyCategoryNames = { main: '主账', adjustment: '调整', marketing: '广宣费 / 投流推广' };
const intercompanyRegionFor = value => intercompanyRegions.find(([, marker]) => String(value || '').includes(marker))?.[0] || '';
const intercompanyOperatingCompanies = () => {
  const byRegion = new Map();
  for (const row of db.prepare("SELECT company_key AS key, company_name AS name FROM companies WHERE company_key <> 'group'").all()) {
    const region = intercompanyRegionFor(row.name); if (!region) continue;
    if (!byRegion.has(region)) byRegion.set(region, []); byRegion.get(region).push({ ...row, region });
  }
  return intercompanyRegions.flatMap(([region]) => byRegion.get(region)?.length === 1 ? byRegion.get(region) : []);
};
const intercompanyPartyMatch = (name, sourceCompany, companies) => {
  const original = String(name || '').trim();
  const compact = original.replace(/桉桥|安侨/g, '桉侨').replace(/[\s（）()【】\[\]]/g, '').replace(/^(?:应收账款|其他应收款|应付账款|其他应付款)[-—－:：]?/, '');
  const internalLooking = /桉侨|侨桉/.test(compact);
  if (!internalLooking) return { internalLooking: false };
  const candidateRegions = intercompanyRegions.filter(([, marker]) => compact.includes(marker)).map(([region]) => region);
  if (candidateRegions.length !== 1) return { internalLooking: true, candidateRegions, reason: candidateRegions.length ? '名称同时包含多个地区' : '无法识别地区' };
  const region = candidateRegions[0]; const target = companies.find(company => company.region === region);
  if (!target) return { internalLooking: true, candidateRegions, reason: '对应公司未登记' };
  if (target.key === sourceCompany.key) return { internalLooking: true, candidateRegions, reason: '疑似本公司主体' };
  const stem = compact.match(new RegExp(`^${region}(?:市)?(?:桉侨|侨桉)(?:(?:移民|出国|海外)?咨询服务|移民服务)?(?:有限责任公司|有限公司|公司)?`))?.[0] || '';
  if (!stem) return { internalLooking: true, candidateRegions, reason: '主体名称格式待确认' };
  const remainder = compact.slice(stem.length).replace(/^[-—－:：]+/, '');
  if (remainder && !/^(?:调整|广宣费?(?:调整)?|投流(?:推广)?(?:调整)?|推广费?(?:调整)?)$/.test(remainder)) return { internalLooking: true, candidateRegions, reason: '名称含未确认的业务后缀' };
  const category = /广宣|投流|推广/.test(remainder) ? 'marketing' : /调整/.test(remainder) ? 'adjustment' : 'main';
  return { internalLooking: true, candidateRegions, target, category, categoryName: intercompanyCategoryNames[category], normalizedName: compact };
};
const intercompanyTrialRowsFor = (company, period, companies) => {
  const source = rawReportFor('trial_balance', company.key, period); const rows = source.raw?.rows || [];
  if (source.meta.noData) return { company, source: { ...source.meta, sourceSheet: source.raw?.sourceSheet || '—' }, rows: [], unmapped: [] };
  const headerIndex = rows.findIndex(row => (row.cells || []).some(value => String(value || '').trim() === '科目编码') && (row.cells || []).some(value => String(value || '').trim() === '科目名称'));
  const headerCells = rows[headerIndex]?.cells || []; const endStart = headerCells.findIndex(value => String(value || '').includes('期末余额'));
  let endDebitIndex = endStart >= 0 ? endStart : 8; let endCreditIndex = endDebitIndex + 1;
  for (const candidate of rows.slice(Math.max(0, headerIndex), Math.max(0, headerIndex) + 4)) {
    const cells = candidate.cells || [];
    if (String(cells[endDebitIndex] || '').trim() === '借方' && String(cells[endCreditIndex] || '').trim() === '贷方') break;
    const debit = cells.findIndex((value, index) => index >= Math.max(0, endStart) && String(value || '').trim() === '借方' && String(cells[index + 1] || '').trim() === '贷方');
    if (debit >= 0) { endDebitIndex = debit; endCreditIndex = debit + 1; }
  }
  const accountKinds = { '1122': ['receivable', '应收账款', 1], '1221': ['otherReceivable', '其他应收款', 1], '2202': ['payable', '应付账款', -1], '2241': ['otherPayable', '其他应付款', -1] };
  const candidates = rows.map(row => {
    const cells = row.cells || []; const code = String(cells[0] || '').replace(/\s+/g, ''); const name = String(cells[1] || '').trim();
    const prefix = Object.keys(accountKinds).find(item => code.startsWith(item)); if (!prefix || code.length <= prefix.length || !name) return null;
    const [field, accountName, sign] = accountKinds[prefix]; const debit = amountFor(cells[endDebitIndex]); const credit = amountFor(cells[endCreditIndex]);
    const balance = sign > 0 ? debit - credit : credit - debit; const match = intercompanyPartyMatch(name, company, companies);
    return { sourceRow: row.row, code, name, field, accountName, debit: roundedAmount(debit), credit: roundedAmount(credit), balance: roundedAmount(balance), net: roundedAmount(balance * sign), directionAbnormal: balance < -intercompanyTolerance, match };
  }).filter(Boolean);
  const mappedCandidates = candidates.filter(row => row.match.target);
  const leafRows = mappedCandidates.filter(row => !mappedCandidates.some(other => other !== row && other.code.startsWith(row.code) && other.code.length > row.code.length));
  const rowsForCompany = leafRows.map(row => ({ sourceRow: row.sourceRow, code: row.code, name: row.name, account: row.accountName, field: row.field, category: row.match.category, categoryName: row.match.categoryName, targetCompanyKey: row.match.target.key, targetCompanyName: row.match.target.name, debit: row.debit, credit: row.credit, balance: row.balance, net: row.net, directionAbnormal: row.directionAbnormal }));
  const unmapped = candidates.filter(row => row.match.internalLooking && !row.match.target && !mappedCandidates.some(other => other.code.startsWith(row.code) && other.code.length > row.code.length)).map(row => ({ sourceCompanyKey: company.key, sourceCompanyName: company.name, sourceRow: row.sourceRow, code: row.code, name: row.name, account: row.accountName, candidateRegions: row.match.candidateRegions || [], reason: row.match.reason || '主体待映射' }));
  return { company, source: { ...source.meta, sourceSheet: source.raw?.sourceSheet || '—' }, rows: rowsForCompany, unmapped };
};
const intercompanySideFor = (sourceAnalysis, targetCompany) => {
  const rows = sourceAnalysis.rows.filter(row => row.targetCompanyKey === targetCompany.key);
  const categories = Object.keys(intercompanyCategoryNames).map(category => ({ category, name: intercompanyCategoryNames[category], net: roundedAmount(rows.filter(row => row.category === category).reduce((sum, row) => sum + row.net, 0)) }));
  return { companyKey: sourceAnalysis.company.key, companyName: sourceAnalysis.company.name, targetCompanyKey: targetCompany.key, targetCompanyName: targetCompany.name, net: roundedAmount(rows.reduce((sum, row) => sum + row.net, 0)), categories, rows, directionAbnormal: rows.some(row => row.directionAbnormal) };
};
const intercompanyPairStatus = (sideA, sideB, missingSources, unmapped) => {
  if (missingSources.length) return { key: 'missing_source', name: '资料缺失', message: `缺少${missingSources.join('、')}科目余额表` };
  if (unmapped.length) return { key: 'unmapped', name: '主体待映射', message: `${unmapped.length} 个相关科目需人工确认主体` };
  if (sideA.directionAbnormal || sideB.directionAbnormal) return { key: 'direction_abnormal', name: '余额方向异常', message: '应收类出现贷方余额或应付类出现借方余额' };
  const hasA = Math.abs(sideA.net) > intercompanyTolerance; const hasB = Math.abs(sideB.net) > intercompanyTolerance;
  if (hasA !== hasB) return { key: 'one_sided', name: '单边挂账', message: '仅一方账面存在往来余额' };
  if (hasA && hasB && Math.sign(sideA.net) === Math.sign(sideB.net)) return { key: 'direction_conflict', name: '方向冲突', message: '双方净往来方向相同，未形成债权债务抵销关系' };
  const difference = roundedAmount(sideA.net + sideB.net);
  if (Math.abs(difference) > intercompanyTolerance) return { key: 'amount_mismatch', name: '金额不一致', message: `双方净往来相加差异超过 ${intercompanyTolerance.toFixed(2)} 元` };
  return { key: 'matched', name: '一致', message: '双方净往来在容差内抵销' };
};
const intercompanyAnalysisFor = (employeeKey, period) => {
  const registeredCompanies = intercompanyOperatingCompanies(); const profile = permissionProfileFor(employeeKey);
  const companies = registeredCompanies.filter(company => profileScopeAllows(profile, company.key, period));
  const analyses = new Map(companies.map(company => [company.key, intercompanyTrialRowsFor(company, period, registeredCompanies)]));
  const pairs = [];
  for (let left = 0; left < companies.length; left++) for (let right = left + 1; right < companies.length; right++) {
    const companyA = companies[left]; const companyB = companies[right]; const analysisA = analyses.get(companyA.key); const analysisB = analyses.get(companyB.key);
    const sideA = intercompanySideFor(analysisA, companyB); const sideB = intercompanySideFor(analysisB, companyA);
    const unmapped = [
      ...analysisA.unmapped.filter(row => row.candidateRegions.includes(companyB.region)),
      ...analysisB.unmapped.filter(row => row.candidateRegions.includes(companyA.region))
    ];
    const missingSources = [analysisA.source.noData ? companyA.name : '', analysisB.source.noData ? companyB.name : ''].filter(Boolean);
    const difference = roundedAmount(sideA.net + sideB.net); const status = intercompanyPairStatus(sideA, sideB, missingSources, unmapped);
    pairs.push({ pairKey: `${companyA.key}::${companyB.key}`, companyA: { key: companyA.key, name: companyA.name, region: companyA.region }, companyB: { key: companyB.key, name: companyB.name, region: companyB.region }, sideA, sideB, difference, absoluteDifference: roundedAmount(Math.abs(difference)), status, unmappedCount: unmapped.length, missingSources });
  }
  pairs.sort((a, b) => b.absoluteDifference - a.absoluteDifference || a.companyA.name.localeCompare(b.companyA.name, 'zh-CN') || a.companyB.name.localeCompare(b.companyB.name, 'zh-CN'));
  const sources = companies.map(company => { const source = analyses.get(company.key).source; return { companyKey: company.key, companyName: company.name, region: company.region, available: !source.noData, sourceSheet: source.sourceSheet, fileName: source.fileName, uploadKey: source.uploadKey }; });
  const unmapped = [...analyses.values()].flatMap(item => item.unmapped);
  const expectedRegions = intercompanyRegions.map(([region]) => region); const registeredRegions = registeredCompanies.map(item => item.region); const scopedRegions = companies.map(item => item.region);
  const matchedCount = pairs.filter(pair => pair.status.key === 'matched').length;
  return {
    analysis: intercompanyModuleKey, company: companyRow('group')?.company_name || '桉侨集团', period, tolerance: intercompanyTolerance,
    expectedCompanyCount: expectedRegions.length, companyCount: companies.length, combinationCount: pairs.length,
    scopeComplete: scopedRegions.length === expectedRegions.length, dataComplete: scopedRegions.length === expectedRegions.length && sources.every(source => source.available),
    missingRegisteredRegions: expectedRegions.filter(region => !registeredRegions.includes(region)), missingScopeRegions: expectedRegions.filter(region => !scopedRegions.includes(region)),
    companies: companies.map(({ key, name, region }) => ({ key, name, region })), sources, pairs,
    metrics: { coveredCompanies: sources.filter(source => source.available).length, combinations: pairs.length, matched: matchedCount, exceptions: pairs.length - matchedCount, absoluteDifference: roundedAmount(pairs.reduce((sum, pair) => sum + pair.absoluteDifference, 0)), unmappedSubjects: unmapped.length },
    statusCounts: Object.fromEntries([...new Set(pairs.map(pair => pair.status.key))].map(key => [key, pairs.filter(pair => pair.status.key === key).length])), unmapped
  };
};
const intercompanyJournalRowsFor = (companyKey, period, accountCodes) => {
  const source = rawReportFor('journal', companyKey, period); if (source.meta.noData) return { available: false, source: source.meta, rows: [], totalRows: 0, truncated: false };
  const raw = source.raw; const codeIndex = journalColumnIndex(raw, '科目编码', 3); const nameIndex = journalColumnIndex(raw, '科目名称', 4); const summaryIndex = journalColumnIndex(raw, '摘要', 2); const voucherIndex = journalColumnIndex(raw, '凭证号', 1); const debitIndex = journalColumnIndex(raw, '借方金额', 5); const creditIndex = journalColumnIndex(raw, '贷方金额', 6);
  const codes = new Set(accountCodes.map(code => String(code || '').replace(/\s+/g, '')));
  const matched = withoutProfitClosingEntries((raw.rows || []).filter(row => row?.row !== 1 && Array.isArray(row.cells) && journalDateFor(row).slice(0, 7) === period && codes.has(String(row.cells[codeIndex] || '').replace(/\s+/g, ''))), row => row.cells?.[summaryIndex], row => row.cells?.[voucherIndex]);
  const rows = matched.slice(0, 500).map(row => ({ row: row.row, date: journalDateFor(row), voucher: String(row.cells[voucherIndex] || '').trim(), summary: String(row.cells[summaryIndex] || '').trim(), accountCode: String(row.cells[codeIndex] || '').trim(), account: String(row.cells[nameIndex] || '').trim(), debit: roundedAmount(amountFor(row.cells[debitIndex])), credit: roundedAmount(amountFor(row.cells[creditIndex])) }));
  return { available: true, source: { ...source.meta, sourceSheet: raw.sourceSheet || '—' }, rows, totalRows: matched.length, truncated: matched.length > rows.length };
};

const parseBody = req => new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 20 * 1024 * 1024) reject(new Error('请求体过大')); }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('请求体不是有效 JSON')); } }); req.on('error', reject); });
const requireImport = (req, res, action) => { const employee = requireEmployee(req, res); if (!employee) return null; if (!hasModule(employee.employee_key, 'report_import', action)) { bad(res, 403, '当前员工没有上传报表权限'); return null; } return employee; };
const importScopeAllows = (employee, res, companyKey, period) => {
  if (profileScopeAllows(permissionProfileFor(employee.employee_key), companyKey, period)) return true;
  bad(res, 403, '当前员工没有该公司或期间的数据范围权限'); return false;
};
const requireReportDataAdmin = (req, res) => { const employee = requireEmployee(req, res); if (!employee) return null; if (!hasModule(employee.employee_key, 'database_admin', 'manage')) { bad(res, 403, '没有权限管理报表数据'); return null; } return employee; };
const directlyDeletableUploadStatuses = new Set(['uploaded', 'parsed', 'validated', 'rejected']);
const deletableUploadStatuses = new Set([...directlyDeletableUploadStatuses, 'published']);
const canDeleteUpload = (employeeKey, upload) => {
  const companyKey = upload.company_key || upload.companyKey;
  const uploaderKey = upload.employee_key || upload.employeeKey;
  const canPublish = hasModule(employeeKey, 'report_import', 'publish');
  if (!profileScopeAllows(permissionProfileFor(employeeKey), companyKey, upload.period)) return false;
  if (upload.status === 'published') return canPublish;
  return directlyDeletableUploadStatuses.has(upload.status) && (uploaderKey === employeeKey || canPublish);
};
const consolidatedEntityFullNames = new Map([
  ['广州桉侨', '广州桉侨有限公司'],
  ['深圳桉侨', '深圳桉侨移民服务有限公司'],
  ['成都桉侨', '成都桉侨出国咨询服务有限公司'],
  ['南京桉侨', '南京桉侨移民服务有限公司'],
  ['长沙桉侨', '长沙桉侨海外咨询服务有限公司'],
  ['青岛桉侨', '青岛桉侨移民服务有限公司'],
  ['北京侨桉', '北京侨桉咨询服务有限公司']
]);
const consolidatedEntityName = (sheetName, companyCell) => {
  const sheetKey = String(sheetName || '').trim();
  const extracted = String(companyCell || '').replace(/^编制单位\s*[:：]?\s*/, '').trim();
  if (consolidatedEntityFullNames.has(sheetKey)) return consolidatedEntityFullNames.get(sheetKey);
  if (/(?:有限责任公司|有限公司|公司)$/.test(extracted)) return extracted;
  return consolidatedEntityFullNames.get(extracted) || extracted || sheetKey;
};
const normalizeStatementDate = rows => {
  const headerIndex = rows.findIndex(row => (row || []).some(value => String(value || '').trim() === '项目') && (row || []).some(value => /本期金额/.test(String(value || ''))));
  const metadataRows = rows.slice(0, headerIndex >= 0 ? headerIndex : Math.min(rows.length, 8));
  const metadataRow = metadataRows.find(row => (row || []).some(value => /编制单位/.test(String(value || ''))))
    || metadataRows.find(row => (row || []).some(value => /单位\s*[:：]/.test(String(value || ''))));
  if (!metadataRow) return rows;
  const dateIndex = metadataRow.findIndex(value => typeof value === 'number' && value >= 30000 && value <= 80000);
  if (dateIndex < 0) return rows;
  const parsedDate = XLSX.SSF.parse_date_code(metadataRow[dateIndex]);
  if (!parsedDate?.y || !parsedDate?.m) return rows;
  metadataRow[dateIndex] = `${parsedDate.y}年${parsedDate.m}月`;
  metadataRow.forEach((value, index) => {
    if (index !== dateIndex && /^20\d{2}年(?:1[0-2]|0?[1-9])月$/.test(String(value || '').trim())) metadataRow[index] = null;
  });
  return rows;
};
const maxUploadSheetRows = 200000;
const maxUploadSheetColumns = 256;
const maxUploadSheetCells = 3000000;
const uploadCellHasValue = cell => {
  const value = cell?.v;
  return value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
};
const uploadRowHasValue = row => (row || []).some(value => value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== ''));
const uploadSheetRows = (sheet, sheetName, requestedRange = '') => {
  const declaredRange = String(sheet?.['!ref'] || '').trim();
  if (!declaredRange && !requestedRange) throw new Error(`工作表“${sheetName}”没有可读取的有效数据`);
  let range;
  if (requestedRange) {
    try { range = XLSX.utils.decode_range(requestedRange); } catch { throw new Error(`工作表“${sheetName}”指定读取范围 ${requestedRange} 无效`); }
  } else {
    let declared;
    try { declared = XLSX.utils.decode_range(declaredRange); } catch { throw new Error(`工作表“${sheetName}”的使用范围 ${declaredRange} 无效`); }
    let minRow = Infinity; let minColumn = Infinity; let maxRow = -1; let maxColumn = -1;
    for (const [address, cell] of Object.entries(sheet || {})) {
      if (address.startsWith('!') || !uploadCellHasValue(cell)) continue;
      let position; try { position = XLSX.utils.decode_cell(address); } catch { continue; }
      minRow = Math.min(minRow, position.r); minColumn = Math.min(minColumn, position.c);
      maxRow = Math.max(maxRow, position.r); maxColumn = Math.max(maxColumn, position.c);
    }
    if (maxRow < 0 || maxColumn < 0) throw new Error(`工作表“${sheetName}”没有可读取的有效数据`);
    range = { s: { r: Math.min(declared.s.r, minRow), c: Math.min(declared.s.c, minColumn) }, e: { r: maxRow, c: maxColumn } };
  }
  const rowCount = range.e.r - range.s.r + 1; const columnCount = range.e.c - range.s.c + 1; const cellCount = rowCount * columnCount;
  const effectiveRange = XLSX.utils.encode_range(range);
  if (rowCount > maxUploadSheetRows || columnCount > maxUploadSheetColumns || cellCount > maxUploadSheetCells) {
    throw new Error(`工作表“${sheetName}”有效数据范围 ${effectiveRange}（${rowCount} 行 × ${columnCount} 列）超过上传限制（最多 ${maxUploadSheetRows} 行、${maxUploadSheetColumns} 列且不超过 ${maxUploadSheetCells} 个单元格），请删除异常空白行列或拆分文件后重试`);
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, range: effectiveRange });
  while (rows.length && !uploadRowHasValue(rows.at(-1))) rows.pop();
  const maxCol = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return { rows, maxCol, declaredRange, effectiveRange, rangeTrimmed: Boolean(!requestedRange && declaredRange && declaredRange !== effectiveRange) };
};
const statementRowsFromSheet = (workbook, sheetName, range) => {
  let rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null, range });
  const bodyEnd = rows.findIndex(row => (row || []).some(value => /四、净利润/.test(String(value || ''))));
  if (bodyEnd >= 0) rows = rows.slice(0, bodyEnd + 1);
  return normalizeStatementDate(rows);
};
const consolidatedEntitiesFromWorkbook = (workbook, mainSheetNames, range) => workbook.SheetNames.filter(name => !mainSheetNames.has(name)).map(name => {
  const rows = statementRowsFromSheet(workbook, name, range);
  const header = rows.find(row => (row || []).some(value => String(value || '').trim() === '项目') && (row || []).some(value => /本期金额/.test(String(value || ''))));
  const companyCell = rows.flat().find(value => /编制单位/.test(String(value || '')));
  if (!header || !companyCell) return null;
  return { sourceSheet: name, companyName: consolidatedEntityName(name, companyCell), rows: rows.map((cells, index) => ({ row: index + 1, cells })) };
}).filter(Boolean);
const revenueCellHasValue = value => value !== null && value !== undefined && String(value).trim() !== '';
const normalizedHeader = value => String(value || '').replace(/[\s\n【】\[\]（）()]/g, '').trim();
const amountCell = value => { const parsed = Number(String(value ?? '').replace(/[,，￥¥元\s]/g, '')); return Number.isFinite(parsed) ? parsed : 0; };
const consultantCanonicalName = value => {
  const text = String(value || '').trim().replace(/\s+/g, '');
  const chinese = text.match(/[\u4e00-\u9fa5]{2,6}/g)?.at(-1) || '';
  return chinese || text.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
};
const consultantDepartmentMatches = value => /顾问/.test(normalizedHeader(value));
const findHeaderIndex = (headers, patterns) => headers.findIndex(header => patterns.some(pattern => pattern.test(normalizedHeader(header))));
const findPreferredHeaderIndex = (headers, patternGroups) => {
  for (const patterns of patternGroups) {
    const index = findHeaderIndex(headers, patterns);
    if (index >= 0) return index;
  }
  return -1;
};
const periodHintsFromText = value => {
  const text = String(value || '').replace(/\s+/g, ''); const periods = [];
  for (const match of text.matchAll(/(20\d{2})(?:年|[.\/_-])(1[0-2]|0?[1-9])月?/g)) periods.push(`${match[1]}-${String(match[2]).padStart(2, '0')}`);
  for (const match of text.matchAll(/(?:^|\D)(20\d{2})(0[1-9]|1[0-2])(?=\D|$)/g)) periods.push(`${match[1]}-${match[2]}`);
  for (const match of text.matchAll(/(?:^|\D)(\d{2})年(1[0-2]|0?[1-9])月/g)) periods.push(`20${match[1]}-${String(match[2]).padStart(2, '0')}`);
  const months = [...text.matchAll(/(?:^|\D)(1[0-2]|0?[1-9])月/g)].map(match => String(match[1]).padStart(2, '0'));
  return { periods: [...new Set(periods)], months: [...new Set(months)] };
};
const payrollDateText = value => {
  if (typeof value === 'number' && value > 30000 && value < 100000) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const text = String(value ?? '').trim();
  const match = text.match(/(20\d{2})[年.\/_-](1[0-2]|0?[1-9])[月.\/_-](3[01]|[12]\d|0?[1-9])日?/);
  if (match) return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  return '';
};
const payrollHeaderMapping = headers => {
  const nameIndex = findPreferredHeaderIndex(headers, [
    [/^(?:中文姓名|员工中文姓名|姓名中文)$/],
    [/^(?:姓名|员工姓名|职员姓名|顾问姓名|人员姓名)$/]
  ]);
  const exactSalaryIndex = findPreferredHeaderIndex(headers, [[/^基本工资$/], [/^(?:月基本工资|应发基本工资|基本薪资|基础工资)$/]]);
  const salaryIndexes = exactSalaryIndex >= 0 ? [exactSalaryIndex] : headers.map((header, index) => /基本工资/.test(normalizedHeader(header)) ? index : -1).filter(index => index >= 0);
  const commissionIndex = findPreferredHeaderIndex(headers, [
    [/^(?:本月提成|当月提成|本期提成)$/],
    [/^提成$/],
    [/提成/]
  ]);
  const safeCommissionIndex = commissionIndex >= 0 && !/(?:往期|历史|累计|合计)提成/.test(normalizedHeader(headers[commissionIndex])) ? commissionIndex : -1;
  const companyIndex = findPreferredHeaderIndex(headers, [[/^(?:公司|所属公司|分公司|公司名称)$/], [/^(?:地区|所属地区)$/]]);
  const departmentIndex = findHeaderIndex(headers, [/^(?:部门|所属部门|部门名称)$/]);
  const hireDateIndex = findPreferredHeaderIndex(headers, [[/^(?:入职日期|入职时间|入职日|到职日期|加入日期)$/]]);
  return { nameIndex, salaryIndexes, commissionIndex: safeCommissionIndex, companyIndex, departmentIndex, hireDateIndex };
};
const genericPayrollSheetCandidates = workbook => workbook.SheetNames.map(name => {
  let rows = [];
  try { rows = uploadSheetRows(workbook.Sheets[name], name).rows.slice(0, 40); } catch {}
  const ranked = rows.map((headers, index) => {
    const mapping = payrollHeaderMapping(headers || []);
    const complete = mapping.nameIndex >= 0 && mapping.departmentIndex >= 0 && mapping.salaryIndexes.length > 0 && mapping.commissionIndex >= 0;
    return { index, mapping, complete };
  }).filter(item => item.complete).sort((a, b) => a.index - b.index);
  return ranked.length ? { name, headerRow: ranked[0].index + 1 } : null;
}).filter(Boolean);
const payrollSheetFor = (workbook, selectedPeriod = '', strict = false) => {
  let candidates = workbook.SheetNames.filter(name => /工资|薪酬明细/.test(String(name).replace(/\s+/g, '')));
  if (!candidates.length && strict) candidates = genericPayrollSheetCandidates(workbook).map(item => item.name);
  if (!candidates.length || !selectedPeriod) return candidates[0] || '';
  const month = selectedPeriod.slice(5, 7); const described = candidates.map(name => ({ name, ...periodHintsFromText(name) }));
  const exact = described.find(item => item.periods.includes(selectedPeriod));
  if (exact) return exact.name;
  const monthOnly = described.find(item => !item.periods.length && item.months.includes(month));
  if (monthOnly) return monthOnly.name;
  const undated = described.find(item => !item.periods.length && !item.months.length);
  if (undated) return undated.name;
  if (strict) throw new Error(`工资文件未找到与所选期间 ${selectedPeriod} 对应的工资工作表；当前识别到：${candidates.join('、')}`);
  return '';
};
const parsePayrollSheet = (workbook, sheetName) => {
  const sheetRows = uploadSheetRows(workbook.Sheets[sheetName], sheetName); const rows = sheetRows.rows;
  const rankedRows = rows.slice(0, 40).map((headers, index) => { const mapping = payrollHeaderMapping(headers || []); const score = Number(mapping.nameIndex >= 0) + Number(mapping.salaryIndexes.length > 0) + Number(mapping.commissionIndex >= 0); return { index, headers: headers || [], mapping, score }; }).sort((a, b) => b.score - a.score || a.index - b.index);
  const header = rankedRows[0]; const missing = [];
  if (!header || header.mapping.nameIndex < 0) missing.push('中文姓名/姓名');
  if (!header || header.mapping.departmentIndex < 0) missing.push('部门');
  if (!header || !header.mapping.salaryIndexes.length) missing.push('基本工资');
  if (!header || header.mapping.commissionIndex < 0) missing.push('本月提成/提成');
  if (missing.length) throw new Error(`工资表工作表“${sheetName}”缺少可识别字段：${missing.join('、')}`);
  const headerRowIndex = header.index; const headers = header.headers;
  const { nameIndex, salaryIndexes, commissionIndex, companyIndex, departmentIndex, hireDateIndex } = header.mapping;
  const payrollRows = rows.slice(headerRowIndex + 1).map((cells, offset) => {
    const company = companyIndex >= 0 ? String(cells?.[companyIndex] || '').trim() : ''; const department = departmentIndex >= 0 ? String(cells?.[departmentIndex] || '').trim() : '';
    const name = String(cells?.[nameIndex] || '').trim();
    if (!name || /合计|总计/.test(name) || /^\d+(?:\.\d+)?$/.test(name) || (companyIndex >= 0 && !company) || /^(?:工资标准|当月应出勤|当月计薪日|计薪天数|应出勤天数)$/.test(normalizedHeader(name))) return null;
    return { row: headerRowIndex + offset + 2, name, canonicalName: consultantCanonicalName(name), company, department, region: company, hireDate: hireDateIndex >= 0 ? payrollDateText(cells?.[hireDateIndex]) : '', baseSalary: salaryIndexes.reduce((sum, index) => sum + amountCell(cells?.[index]), 0), commission: amountCell(cells?.[commissionIndex]) };
  }).filter(row => row?.canonicalName && (row.baseSalary || row.commission));
  if (!payrollRows.length) throw new Error('工资表未识别到包含基本工资或提成的人员数据');
  const sheetMeta = workbook.Workbook?.Sheets?.find(item => item.name === sheetName);
  const fieldMapping = { company: companyIndex >= 0 ? String(headers[companyIndex] || '').trim() : '', department: departmentIndex >= 0 ? String(headers[departmentIndex] || '').trim() : '', name: String(headers[nameIndex] || '').trim(), hireDate: hireDateIndex >= 0 ? String(headers[hireDateIndex] || '').trim() : '', baseSalary: salaryIndexes.map(index => String(headers[index] || '').trim()).filter(Boolean), commission: String(headers[commissionIndex] || '').trim() };
  return { sourceSheet: sheetName, hidden: Boolean(sheetMeta?.Hidden), maxRow: rows.length, maxCol: sheetRows.maxCol, declaredRange: sheetRows.declaredRange, effectiveRange: sheetRows.effectiveRange, rangeTrimmed: sheetRows.rangeTrimmed, headerRow: headerRowIndex + 1, fieldMapping, payrollRows, rows: payrollRows.map(item => ({ row: item.row, cells: [item.company, item.department, item.name, item.hireDate, item.baseSalary, item.commission] })) };
};
const revenuePeriodForValue = (value, selectedPeriod) => {
  if (typeof value === 'number' && value > 30000 && value < 100000) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}`;
  }
  const hints = periodHintsFromText(value);
  if (hints.periods.length) return hints.periods[0];
  return selectedPeriod && hints.months.length ? `${selectedPeriod.slice(0, 4)}-${hints.months[0]}` : '';
};
const parseConsultantRevenueDetail = (workbook, selectedPeriod = '') => {
  for (const sheetName of workbook.SheetNames) {
    const compactName = String(sheetName).replace(/\s+/g, ''); if (!/总营收明细|营收总明细/.test(compactName)) continue;
    const sheetRows = uploadSheetRows(workbook.Sheets[sheetName], sheetName); const rows = sheetRows.rows;
    const headerRowIndex = rows.slice(0, 60).findIndex(row => findHeaderIndex(row || [], [/签约顾问(?:\/渠道)?/, /签约顾问渠道/]) >= 0 && findHeaderIndex(row || [], [/预计营收/]) >= 0 && findHeaderIndex(row || [], [/业绩归属/, /归属地区/]) >= 0);
    if (headerRowIndex < 0) continue;
    const headers = rows[headerRowIndex] || []; const consultantIndex = findHeaderIndex(headers, [/签约顾问(?:\/渠道)?/, /签约顾问渠道/]); const revenueIndex = findHeaderIndex(headers, [/预计营收/]); const regionIndex = findHeaderIndex(headers, [/业绩归属/, /归属地区/]); const periodIndex = findHeaderIndex(headers, [/^(?:月份|统计月份|营收月份|归属月份)$/]);
    let excludedPeriodRows = 0;
    const detailRows = rows.slice(headerRowIndex + 1).map((cells, offset) => {
      const consultant = String(cells?.[consultantIndex] || '').trim(); const expectedRevenue = amountCell(cells?.[revenueIndex]);
      if (!consultant || !expectedRevenue) return null;
      const sourcePeriod = periodIndex >= 0 ? revenuePeriodForValue(cells?.[periodIndex], selectedPeriod) : selectedPeriod;
      if (selectedPeriod && periodIndex >= 0 && sourcePeriod !== selectedPeriod) { excludedPeriodRows += 1; return null; }
      return { row: headerRowIndex + offset + 2, consultant, canonicalName: consultantCanonicalName(consultant), region: String(cells?.[regionIndex] || '').trim(), sourcePeriod, expectedRevenue };
    }).filter(Boolean);
    return { sourceSheet: sheetName, headerRow: headerRowIndex + 1, selectedPeriod, excludedPeriodRows, fieldMapping: { consultant: String(headers[consultantIndex] || '').trim(), region: String(headers[regionIndex] || '').trim(), expectedRevenue: String(headers[revenueIndex] || '').trim(), period: periodIndex >= 0 ? String(headers[periodIndex] || '').trim() : '' }, rows: detailRows };
  }
  return { sourceSheet: '', headerRow: 0, selectedPeriod, excludedPeriodRows: 0, fieldMapping: {}, rows: [] };
};
const revenueDimensionDefinitions = [
  { key: 'group', name: '集团维度', titlePattern: /集团维度/, tableKeys: ['B1', 'B2', 'B3'] },
  { key: 'direct', name: '单独直客维度', titlePattern: /单独直客维度/, tableKeys: ['B4', 'B5', 'B6'] },
  { key: 'channel', name: '单独渠道维度', titlePattern: /单独渠道维度/, tableKeys: ['B7', 'B8'] }
];
const revenueTableTitleDefinitions = [
  { key: 'B1', pattern: /营收总表(?:B1)?$/i },
  { key: 'B2', pattern: /项目营收排行(?:B2)?$/i },
  { key: 'B3', pattern: /项目经理营收明细(?:B3)?$/i },
  { key: 'B4', pattern: /直客.*项目来源统计总表(?:B4)?$/i },
  { key: 'B5', pattern: /直客营收排名(?:B5)?$/i },
  { key: 'B6', pattern: /直客营收明细排名统计(?:B6)?$/i },
  { key: 'B7', pattern: /渠道营收排名(?:B7)?$/i },
  { key: 'B8', pattern: /渠道营收明细排名统计(?:B8)?$/i }
];
const revenueCumulativeTableDefinitions = [
  { key: 'L1', titlePattern: /总集团营收表.*时间划分/i, headers: [/月份/, /(?:预计|实际|实收)?营收(?:金额|总额)?/, /(?:营收)?占比/, /项目(?:数量|数)/] },
  { key: 'L2', titlePattern: /营收总表.*(?:区域|地区)划分/i, headers: [/(?:业绩归属|区域|地区)/, /月份/, /(?:预计|实际|实收)?营收(?:金额|总额)?/, /(?:营收)?占比/, /项目(?:数量|数)/] },
  { key: 'L2-1', titlePattern: /营收项目明细表.*(?:区域|地区)划分/i, headers: [/(?:业绩归属|区域|地区)/, /月份/, /项目/, /(?:预计|实际|实收)?营收(?:金额|总额)?/, /(?:营收)?占比/, /项目(?:数量|数)/] },
  { key: 'L3', titlePattern: /项目(?:负责人|经理)营收累计表/i, headers: [/项目(?:负责人|经理)/, /月份/, /(?:预计|实际|实收)?营收(?:金额|总额)?/, /(?:营收)?占比/, /项目(?:数量|数)/] },
  { key: 'L4', titlePattern: /直客.*来源统计累计表/i, headers: [/(?:来源|项目来源)/, /月份/, /(?:预计|实际|实收)?营收(?:金额|总额)?/, /(?:营收)?占比/, /项目(?:数量|数)/] },
  { key: 'L5', titlePattern: /直客营收统计累计表/i, headers: [/顾问/, /(?:来源|项目来源)/, /(?:预计|实际|实收)?营收(?:金额|总额)?/, /(?:营收)?占比/, /项目(?:数量|数)/] },
  { key: 'L6', titlePattern: /渠道营收统计累计表/i, headers: [/(?:渠道顾问|渠道)/, /月份/, /(?:预计|实际|实收)?营收(?:金额|总额)?/, /(?:营收)?占比/, /项目(?:数量|数)/] }
];
const revenueCumulativeTitleKey = value => String(value || '').replace(/\s+/g, '').match(/(L(?:2-1|[1-6]))$/i)?.[1]?.toUpperCase() || '';
const parseRevenueCumulativeSections = rows => {
  const issues = [];
  const sections = rows.map((row, rowIndex) => {
    const title = (row || []).map(value => String(value || '').trim()).find(value => /^20\d{2}年(?:度)?累计(?:统计)?数据$/.test(value.replace(/\s+/g, '')));
    const year = title?.match(/^(20\d{2})年/)?.[1];
    return year ? { year, title, rowIndex } : null;
  }).filter(Boolean);
  const cumulativeYears = sections.map((section, sectionIndex) => {
    const sectionEnd = sections[sectionIndex + 1]?.rowIndex ?? rows.length;
    const candidates = [];
    for (let rowIndex = section.rowIndex + 1; rowIndex < sectionEnd; rowIndex += 1) {
      for (let column = 0; column < (rows[rowIndex] || []).length; column += 1) {
        const title = String(rows[rowIndex]?.[column] || '').trim();
        if (!title) continue;
        const normalizedTitle = normalizedHeader(title); const titleKey = revenueCumulativeTitleKey(title);
        const definition = revenueCumulativeTableDefinitions.find(item => item.key === titleKey || item.titlePattern.test(normalizedTitle));
        if (definition && !candidates.some(item => item.definition.key === definition.key)) candidates.push({ definition, title, rowIndex, column });
      }
    }
    candidates.sort((a, b) => a.column - b.column || a.rowIndex - b.rowIndex);
    const tables = candidates.map((anchor, index) => {
      const nextColumn = candidates[index + 1]?.column ?? Math.max(anchor.column + 1, rows.reduce((max, row) => Math.max(max, row?.length || 0), 0));
      let headerRowIndex = -1; let headers = [];
      for (let rowIndex = anchor.rowIndex + 1; rowIndex < Math.min(sectionEnd, anchor.rowIndex + 13); rowIndex += 1) {
        const candidateHeaders = (rows[rowIndex] || []).slice(anchor.column, nextColumn);
        const normalizedHeaders = candidateHeaders.map(normalizedHeader);
        if (!anchor.definition.headers.every(pattern => normalizedHeaders.some(header => pattern.test(header)))) continue;
        headerRowIndex = rowIndex; headers = candidateHeaders;
        while (headers.length && !revenueCellHasValue(headers.at(-1))) headers.pop();
        break;
      }
      if (headerRowIndex < 0 || !headers.length) {
        issues.push(`${section.year}年${anchor.definition.key}“${anchor.title}”未找到匹配字段表头`);
        return null;
      }
      const dataRows = []; let emptyStreak = 0; let started = false;
      for (let rowIndex = headerRowIndex + 1; rowIndex < sectionEnd; rowIndex += 1) {
        const cells = (rows[rowIndex] || []).slice(anchor.column, anchor.column + headers.length);
        if (!cells.some(revenueCellHasValue)) {
          if (started && ++emptyStreak >= 3) break;
          continue;
        }
        started = true; emptyStreak = 0; dataRows.push({ row: rowIndex + 1, cells });
      }
      const shortTitle = anchor.title.replace(/^20\d{2}年/, '').replace(/L(?:2-1|[1-6])$/i, '').trim();
      return { key: anchor.definition.key, title: anchor.title, shortTitle, titleRow: anchor.rowIndex + 1, headerRow: headerRowIndex + 1, headers: headers.map(value => String(value ?? '').trim()), rows: dataRows };
    }).filter(Boolean);
    const missing = revenueCumulativeTableDefinitions.filter(definition => !tables.some(table => table.key === definition.key)).map(definition => definition.key);
    if (missing.length) issues.push(`${section.year}年累计数据缺少可识别子表：${missing.join('、')}`);
    return { year: section.year, sourceTitle: section.title, tables };
  });
  return { cumulativeYears, cumulativeIssues: [...new Set(issues)] };
};
const parseRevenueStatisticsSheet = (workbook, sheetName, selectedPeriod = '') => {
  const sheet = workbook.Sheets[sheetName];
  const sheetRows = uploadSheetRows(sheet, sheetName); const rows = sheetRows.rows;
  const dimensionRowIndex = rows.findIndex(row => revenueDimensionDefinitions.every(definition => (row || []).some(value => definition.titlePattern.test(String(value || '')))));
  const tableTitleRowIndex = rows.findIndex(row => revenueTableTitleDefinitions.every(definition => (row || []).some(value => definition.pattern.test(normalizedHeader(value)))));
  if (dimensionRowIndex < 0 || tableTitleRowIndex < 0) throw new Error('营收统计汇总表缺少三个维度标题或 B1-B8 二级表标题');
  const anchors = (rows[tableTitleRowIndex] || []).map((value, column) => {
    const title = String(value || '').trim(); const normalizedTitle = normalizedHeader(title); const match = title.match(/B([1-8])\s*$/i); const definition = revenueTableTitleDefinitions.find(item => item.pattern.test(normalizedTitle));
    return match || definition ? { key: match ? `B${match[1]}` : definition.key, title, column } : null;
  }).filter(Boolean).sort((a, b) => a.column - b.column);
  if (anchors.length !== 8) throw new Error(`营收统计汇总表应包含 B1-B8 八张二级表，当前识别 ${anchors.length} 张`);
  const headerRowIndex = tableTitleRowIndex + 1;
  const tables = anchors.map((anchor, index) => {
    const nextColumn = anchors[index + 1]?.column ?? Math.max(anchor.column + 1, rows.reduce((max, row) => Math.max(max, row?.length || 0), 0));
    let headers = (rows[headerRowIndex] || []).slice(anchor.column, nextColumn);
    while (headers.length && !revenueCellHasValue(headers.at(-1))) headers.pop();
    if (!headers.length) throw new Error(`${anchor.key} 缺少表头`);
    const dataRows = [];
    for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
      const cells = (rows[rowIndex] || []).slice(anchor.column, anchor.column + headers.length);
      if (!cells.some(revenueCellHasValue)) break;
      dataRows.push({ row: rowIndex + 1, cells });
    }
    const shortTitle = anchor.title.replace(/^20\d{2}年\d{1,2}月/, '').replace(/B[1-8]\s*$/i, '').trim();
    return { key: anchor.key, title: anchor.title, shortTitle, headers: headers.map(value => String(value ?? '').trim()), rows: dataRows };
  });
  const dimensionTitles = rows[dimensionRowIndex] || [];
  const dimensions = revenueDimensionDefinitions.map(definition => ({
    key: definition.key,
    name: definition.name,
    sourceTitle: String(dimensionTitles.find(value => definition.titlePattern.test(String(value || ''))) || definition.name).trim(),
    tables: definition.tableKeys.map(key => tables.find(table => table.key === key)).filter(Boolean)
  }));
  const periodMatch = tables.map(table => table.title).join(' ').match(/(20\d{2})年(1[0-2]|0?[1-9])月/);
  const note = rows.flat().map(value => String(value || '').trim()).find(value => /^注[：:]/.test(value)) || '';
  const sheetMeta = workbook.Workbook?.Sheets?.find(item => item.name === sheetName);
  const consultantRevenue = parseConsultantRevenueDetail(workbook, selectedPeriod);
  const cumulative = parseRevenueCumulativeSections(rows);
  return { sourceSheet: sheetName, sourcePeriod: periodMatch ? `${periodMatch[1]}-${String(periodMatch[2]).padStart(2, '0')}` : '', hidden: Boolean(sheetMeta?.Hidden), maxRow: rows.length, maxCol: sheetRows.maxCol, declaredRange: sheetRows.declaredRange, effectiveRange: sheetRows.effectiveRange, rangeTrimmed: sheetRows.rangeTrimmed, note, dimensions, ...cumulative, consultantRevenue };
};
const cellPeriod = value => {
  if (typeof value === 'number' && value > 30000 && value < 100000) return excelDateText(value).slice(0, 7);
  const text = String(value ?? '').trim();
  const iso = text.match(/^(20\d{2})[-/.](1[0-2]|0?[1-9])[-/.](?:3[01]|[12]\d|0?[1-9])/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}`;
  return '';
};
const journalRowsForSelectedPeriod = (rows, selectedPeriod) => {
  if (!selectedPeriod) return { rows, sourcePeriods: [], excludedRows: 0, excludeReport: false };
  const headerIndex = rows.slice(0, 40).findIndex(row => (row || []).some(value => normalizedHeader(value) === '日期'));
  if (headerIndex < 0) return { rows, sourcePeriods: [], excludedRows: 0, excludeReport: false };
  const dateIndex = (rows[headerIndex] || []).findIndex(value => normalizedHeader(value) === '日期');
  const sourcePeriods = new Set(); let activePeriod = ''; let datedRows = 0; let selectedDatedRows = 0; let excludedRows = 0;
  const kept = rows.filter((row, index) => {
    if (index <= headerIndex) return true;
    const rowPeriod = cellPeriod(row?.[dateIndex]);
    if (rowPeriod) { activePeriod = rowPeriod; sourcePeriods.add(rowPeriod); datedRows += 1; if (rowPeriod === selectedPeriod) selectedDatedRows += 1; }
    if (!activePeriod || activePeriod === selectedPeriod) return true;
    excludedRows += 1; return false;
  });
  return { rows: kept, sourcePeriods: [...sourcePeriods], excludedRows, excludeReport: datedRows > 0 && selectedDatedRows === 0 };
};
const trialPeriodsFromMetadata = (rows, sheetName) => {
  const explicit = [];
  const headerIndex = rows.slice(0, 20).findIndex(row => (row || []).some(value => /科目编码/.test(normalizedHeader(value))) && (row || []).some(value => /科目名称/.test(normalizedHeader(value))));
  const metadataRows = rows.slice(0, headerIndex >= 0 ? headerIndex : Math.min(rows.length, 8));
  for (const value of metadataRows.flat()) {
    const numericPeriod = cellPeriod(value); if (numericPeriod) explicit.push(numericPeriod);
    explicit.push(...periodHintsFromText(value).periods);
  }
  if (!explicit.length) explicit.push(...periodHintsFromText(sheetName).periods);
  return [...new Set(explicit)];
};
const parseUploadedFile = (buffer, fileName, fileType, options = {}) => {
  if (fileType === 'application/json' || fileName.toLowerCase().endsWith('.json')) {
    const parsed = JSON.parse(buffer.toString('utf8'));
    return ['balance_sheet', 'income_statement', 'consolidated_income_statement', revenueProfitReportType, revenueStatisticsReportType, payrollStatementReportType, 'cash_flow', 'trial_balance', 'journal'].some(type => parsed[type]) ? parsed : { uploaded: parsed };
  }
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const reports = {};
  const periodExcludedReports = [];
  const reportSheetPatterns = {
    balance_sheet: /^(?:(?:20\d{2}年)?\d{1,2}月)?资产负债表$/,
    income_statement: /^(?:(?:20\d{2}年)?\d{1,2}月)?利润表$/,
    consolidated_income_statement: /^(?:桉侨)?集团(?:合并)?利润表$/,
    [revenueProfitReportType]: /^(?:营收利润口径|营收口径)集团(?:合并)?利润表$/,
    [revenueStatisticsReportType]: /^(?:20\d{2}年)?数据统计汇总表[（(]?mia[）)]?$/i,
    [payrollStatementReportType]: /工资|薪酬明细/,
    cash_flow: /^(?:(?:20\d{2}年)?\d{1,2}月)?现金流量表(?:-钱去向)?$/,
    trial_balance: /^(?:(?:20\d{2}年)?\d{1,2}月)?科目余额表$/,
    journal: /^(?:(?:20\d{2}年)?\d{1,2}月)?序时账$/
  };
  for (const [type, pattern] of Object.entries(reportSheetPatterns)) {
    const requestedGroupType = groupStatementReportTypes.has(options.requestedReportType) ? options.requestedReportType : '';
    if (requestedGroupType && ((type === 'income_statement') || (groupStatementReportTypes.has(type) && type !== requestedGroupType))) continue;
    let sheetName = type === payrollStatementReportType
      ? payrollSheetFor(workbook, options.selectedPeriod, options.requestedReportType === payrollStatementReportType)
      : workbook.SheetNames.find(name => pattern.test(String(name).replace(/\s+/g, '')));
    if (!sheetName && type === requestedGroupType) sheetName = workbook.SheetNames.find(name => /^利润表$/.test(String(name).replace(/\s+/g, '')));
    if (!sheetName) continue;
    if (type === revenueStatisticsReportType) { reports[type] = parseRevenueStatisticsSheet(workbook, sheetName, options.selectedPeriod); continue; }
    if (type === payrollStatementReportType) { reports[type] = parsePayrollSheet(workbook, sheetName); continue; }
    const sheetRows = uploadSheetRows(workbook.Sheets[sheetName], sheetName); let rows = sheetRows.rows;
    if (type === 'journal') {
      const periodCheck = journalRowsForSelectedPeriod(rows, options.selectedPeriod);
      if (periodCheck.excludeReport) {
        periodExcludedReports.push({ reportType: type, sourceSheet: sheetName, selectedPeriod: options.selectedPeriod, detectedPeriods: periodCheck.sourcePeriods, excludedRows: periodCheck.excludedRows, reason: '序时账没有所选期间的分录' });
        continue;
      }
      rows = periodCheck.rows;
      if (periodCheck.excludedRows) periodExcludedReports.push({ reportType: type, sourceSheet: sheetName, selectedPeriod: options.selectedPeriod, detectedPeriods: periodCheck.sourcePeriods, excludedRows: periodCheck.excludedRows, reason: '已排除其他期间的序时账分录' });
    }
    if (type === 'trial_balance' && options.selectedPeriod) {
      const sourcePeriods = trialPeriodsFromMetadata(rows, sheetName);
      if (sourcePeriods.length && !sourcePeriods.includes(options.selectedPeriod)) {
        periodExcludedReports.push({ reportType: type, sourceSheet: sheetName, selectedPeriod: options.selectedPeriod, detectedPeriods: sourcePeriods, excludedRows: rows.length, reason: '科目余额表期间与所选期间不一致' });
        continue;
      }
    }
    if (['balance_sheet', 'income_statement', 'cash_flow'].includes(type)) rows = normalizeStatementDate(rows);
    if (groupStatementReportTypes.has(type)) rows = statementRowsFromSheet(workbook, sheetName, type === revenueProfitReportType ? 'B1:H50' : 'B1:E50');
    const maxCol = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const sheetMeta = workbook.Workbook?.Sheets?.find(item => item.name === sheetName);
    reports[type] = { sourceSheet: sheetName, hidden: Boolean(sheetMeta?.Hidden), maxRow: rows.length, maxCol, declaredRange: sheetRows.declaredRange, effectiveRange: sheetRows.effectiveRange, rangeTrimmed: sheetRows.rangeTrimmed, rows: rows.map((cells, index) => ({ row: index + 1, cells })) };
  }
  const consolidatedMainSheets = new Set([...groupStatementReportTypes].map(type => reports[type]?.sourceSheet).filter(Boolean));
  for (const type of groupStatementReportTypes) {
    if (!reports[type]) continue;
    const entities = consolidatedEntitiesFromWorkbook(workbook, consolidatedMainSheets, type === revenueProfitReportType ? 'B1:H50' : 'B1:E50');
    reports[type].entities = entities;
    reports[type].entityNames = entities.map(item => item.companyName);
    if (type !== 'consolidated_income_statement') continue;
    reports.consolidated_income_statement.reconciliationAvailable = entities.length > 0;
    if (!entities.length) {
      reports.consolidated_income_statement.reconciliation = [];
      reports.consolidated_income_statement.reconciliationPassed = null;
      continue;
    }
    const entityRowsByName = entities.map(entity => new Map(entity.rows.map(row => [String(row.cells?.[0] || '').trim(), row.cells || []])));
    const reconciliation = reports.consolidated_income_statement.rows.filter(row => row.row >= 5).map(row => {
      const label = String(row.cells?.[0] || '').trim();
      const entityAnnual = entityRowsByName.reduce((sum, items) => sum + (Number(items.get(label)?.[2]) || 0), 0);
      const entityCurrent = entityRowsByName.reduce((sum, items) => sum + (Number(items.get(label)?.[3]) || 0), 0);
      const groupAnnual = Number(row.cells?.[2]); const groupCurrent = Number(row.cells?.[3]);
      return { row: row.row, label, annualDifference: Number.isFinite(groupAnnual) ? Number((groupAnnual - entityAnnual).toFixed(2)) : null, currentDifference: Number.isFinite(groupCurrent) ? Number((groupCurrent - entityCurrent).toFixed(2)) : null };
    });
    reports.consolidated_income_statement.reconciliation = reconciliation;
    reports.consolidated_income_statement.reconciliationPassed = reconciliation.every(item => Math.abs(item.annualDifference || 0) <= 0.01 && Math.abs(item.currentDifference || 0) <= 0.01);
  }
  const cashFlowWorkpaperName = workbook.SheetNames.find(name => /现金流量表底稿/.test(name));
  if (cashFlowWorkpaperName) {
    const sheetRows = uploadSheetRows(workbook.Sheets[cashFlowWorkpaperName], cashFlowWorkpaperName); const rows = sheetRows.rows;
    const maxCol = sheetRows.maxCol;
    const sheetMeta = workbook.Workbook?.Sheets?.find(item => item.name === cashFlowWorkpaperName);
    reports.cash_flow_workpaper = { sourceSheet: cashFlowWorkpaperName, hidden: Boolean(sheetMeta?.Hidden), maxRow: rows.length, maxCol, declaredRange: sheetRows.declaredRange, effectiveRange: sheetRows.effectiveRange, rangeTrimmed: sheetRows.rangeTrimmed, rows: rows.map((cells, index) => ({ row: index + 1, cells })) };
  }
  Object.defineProperty(reports, 'periodExcludedReports', { value: periodExcludedReports, enumerable: false });
  if (!Object.keys(reports).length && !periodExcludedReports.length) throw new Error('未找到可识别的资产负债表、利润表、集团合并利润表、营收利润口径合并利润表、营收统计汇总表、工资表、现金流量表、科目余额表或序时账工作表');
  return reports;
};
const uploadPeriodHint = (fileName, reports, selectedPeriod) => {
  const sources = [fileName, ...Object.values(reports).flatMap(item => [item?.sourceSheet, item?.sourcePeriod])].filter(Boolean).map(String);
  const explicit = sources.flatMap(source => periodHintsFromText(source).periods.map(period => ({ period, source })));
  const explicitPeriods = [...new Set(explicit.map(item => item.period))];
  const monthHints = [...new Set(sources.flatMap(source => periodHintsFromText(source).months))];
  if (explicitPeriods.length > 1 || (!explicitPeriods.length && monthHints.length > 1)) {
    return { conflict: true, sources, explicitPeriods, monthHints };
  }
  const detectedPeriod = explicitPeriods[0] || (monthHints[0] ? `${String(selectedPeriod).slice(0, 4)}-${monthHints[0]}` : '');
  return { conflict: false, detectedPeriod, sources, explicitPeriods, monthHints };
};
const uploadCompanyHint = (fileName, reports) => {
  const normalize = value => String(value || '').replace(/桉桥/g, '桉侨').replace(/[\s市]/g, '');
  const aliases = value => {
    const full = normalize(value); if (full === '桉侨集团') return [full]; const brandEnd = full.indexOf('桉侨');
    const short = brandEnd >= 0 ? full.slice(0, brandEnd + 2) : full.replace(/(?:有限责任公司|有限公司|公司)$/, '');
    return [...new Set([full, short].filter(alias => alias.length >= 2))];
  };
  const sources = [fileName];
  const normalizedSources = sources.map(normalize).filter(Boolean);
  const matches = db.prepare('SELECT company_key AS key, company_name AS name FROM companies ORDER BY company_key').all().filter(company => normalizedSources.some(source => aliases(company.name).some(alias => source.includes(alias))));
  if (matches.length > 1) return { conflict: true, matches, sources };
  return { conflict: false, detectedCompanyKey: matches[0]?.key || '', detectedCompanyName: matches[0]?.name || '', sources };
};
const lineCandidatesFromRaw = (raw, reportType = '') => {
  const rows = raw?.rows || [];
  const headerCells = rows.find(item => (item.cells || []).some(value => /本期金额|本年累计金额|前期累计金额/.test(String(value || ''))))?.cells || [];
  const currentIndex = headerCells.findIndex(value => /本期金额/.test(String(value || '')));
  const priorIndex = headerCells.findIndex(value => /本年累计金额|前期累计金额/.test(String(value || '')));
  return rows.map(item => {
    const cells = item.cells || [];
    const nameIndex = cells.findIndex(value => typeof value === 'string' && value.trim());
    if (nameIndex < 0) return null;
    const numbers = cells.filter(value => typeof value === 'number' && Number.isFinite(value));
    if (!numbers.length) return null;
    const statementReport = ['income_statement', 'consolidated_income_statement', revenueProfitReportType, 'cash_flow'].includes(reportType);
    const current = statementReport
      ? (currentIndex >= 0 && typeof cells[currentIndex] === 'number' ? cells[currentIndex] : numbers[numbers.length - 1])
      : numbers[0];
    const prior = statementReport
      ? (priorIndex >= 0 && typeof cells[priorIndex] === 'number' ? cells[priorIndex] : numbers[numbers.length - 2] || 0)
      : numbers[1];
    return { code: `raw-${item.row}`, name: String(cells[nameIndex]).trim(), category: '原始资料', current: Number(current || 0), prior: Number(prior || 0), row: item.row };
  }).filter(Boolean).slice(0, 100);
};
const createNormalizedSnapshot = (upload, reports) => {
  const raw = reports[upload.report_type] || reports[Object.keys(reports)[0]];
  if (!raw) return null;
  const version = (db.prepare('SELECT COALESCE(MAX(version), 0) AS max FROM report_snapshots WHERE company_key = ? AND period = ? AND report_type = ?').get(upload.company_key, upload.period, upload.report_type).max || 0) + 1;
  const snapshotKey = `${upload.company_key}-${upload.period}-${upload.report_type}-upload-${upload.upload_key}`;
  db.prepare('INSERT INTO report_snapshots(snapshot_key, company_key, period, report_type, version, status, source_name, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(snapshotKey, upload.company_key, upload.period, upload.report_type, version, 'validated', upload.file_name, `上传批次 ${upload.upload_key}`, now());
  const addLine = db.prepare('INSERT INTO report_lines(snapshot_key, line_code, line_name, category, current_amount, prior_amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
  lineCandidatesFromRaw(raw, upload.report_type).forEach((line, index) => addLine.run(snapshotKey, line.code, line.name, line.category, line.current, line.prior, index));
  return snapshotKey;
};
const reportLinesForSnapshot = (snapshot, reportType) => {
  let lines = db.prepare('SELECT line_code AS code, line_name AS name, category, current_amount AS current, prior_amount AS prior FROM report_lines WHERE snapshot_key = ? ORDER BY sort_order').all(snapshot.snapshot_key);
  if (!['income_statement', 'consolidated_income_statement', revenueProfitReportType, 'cash_flow'].includes(reportType) || !snapshot.snapshot_key.includes('-upload-')) return lines;
  const uploadKey = snapshot.snapshot_key.split('-upload-')[1];
  const upload = db.prepare('SELECT raw_path FROM upload_batches WHERE upload_key = ?').get(uploadKey);
  if (!upload?.raw_path || !fs.existsSync(upload.raw_path)) return lines;
  try {
    const parsed = JSON.parse(fs.readFileSync(upload.raw_path, 'utf8'));
    const reparsed = lineCandidatesFromRaw(parsed[reportType] || parsed, reportType);
    if (reparsed.length) lines = reparsed.map(({ code, name, category, current, prior }) => ({ code, name, category, current, prior }));
  } catch {}
  return lines;
};
const groupProfitLineAmount = (lines, target) => {
  const normalize = value => String(value || '')
    .replace(/\s+/g, '')
    .replace(/^[一二三四五六七八九十]+、/, '')
    .replace(/^(?:加|减|其中)[：:]/, '')
    .replace(/[（(].*$/, '')
    .trim();
  const line = (lines || []).find(item => normalize(item.name) === target);
  return Number(line?.current || 0);
};
const consolidatedEntitiesFor = (reportType, companyKey, period, employeeKey) => {
  if (!groupStatementReportTypes.has(reportType) || companyKey !== 'group' || !hasReport(employeeKey, reportType, 'summary', 'view', companyKey, period)) return [];
  const upload = db.prepare("SELECT raw_path FROM upload_batches WHERE company_key = 'group' AND period = ? AND report_type = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1").get(period, reportType);
  if (!upload?.raw_path || !fs.existsSync(upload.raw_path)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(upload.raw_path, 'utf8'));
    const raw = parsed[reportType] || parsed;
    return (raw.entities || []).map(entity => ({
      sourceSheet: String(entity.sourceSheet || '').trim(),
      companyName: String(entity.companyName || '').trim()
    })).filter(entity => entity.sourceSheet && entity.companyName);
  } catch {
    return [];
  }
};
const groupProfitAnalysisFor = (period, year) => {
  const effectiveYear = /^\d{4}$/.test(String(year || '')) ? String(year) : String(period).slice(0, 4);
  const snapshots = db.prepare("SELECT * FROM report_snapshots WHERE company_key = 'group' AND report_type = 'consolidated_income_statement' AND status = 'published' AND snapshot_key LIKE '%-upload-%' AND period LIKE ? AND period <= ? ORDER BY period").all(`${effectiveYear}-%`, period);
  const monthly = snapshots.map(snapshot => {
    const lines = reportLinesForSnapshot(snapshot, 'consolidated_income_statement');
    const sellingExpense = groupProfitLineAmount(lines, '销售费用');
    const administrationExpense = groupProfitLineAmount(lines, '管理费用');
    const financeExpense = groupProfitLineAmount(lines, '财务费用');
    return {
      period: snapshot.period,
      revenue: groupProfitLineAmount(lines, '营业收入'),
      cost: groupProfitLineAmount(lines, '营业成本'),
      sellingExpense,
      administrationExpense,
      financeExpense,
      periodExpense: sellingExpense + administrationExpense + financeExpense,
      netProfit: groupProfitLineAmount(lines, '净利润'),
      version: snapshot.version,
      sourceName: snapshot.source_name
    };
  });
  return {
    year: effectiveYear,
    monthly,
    source: monthly.length ? { noData: false, reportType: 'consolidated_income_statement', reportName: '桉侨集团合并利润表', periods: monthly.map(item => item.period), files: [...new Set(monthly.map(item => item.sourceName))] } : { noData: true, reportType: 'consolidated_income_statement', reportName: '桉侨集团合并利润表', periods: [], files: [] }
  };
};
const revenueStatisticsRefreshCache = new Map();
const refreshedRevenueStatisticsRawFor = (revenue, period) => {
  const consultantReady = revenue.raw?.consultantRevenue?.selectedPeriod === period;
  const cumulativeReady = Array.isArray(revenue.raw?.cumulativeYears);
  if ((consultantReady && cumulativeReady) || !revenue.meta?.uploadKey) return revenue.raw;
  if (revenueStatisticsRefreshCache.has(revenue.meta.uploadKey)) return revenueStatisticsRefreshCache.get(revenue.meta.uploadKey);
  const upload = db.prepare('SELECT file_name, file_type, storage_path FROM upload_batches WHERE upload_key = ?').get(revenue.meta.uploadKey);
  let refreshed = revenue.raw;
  if (upload?.storage_path && fs.existsSync(upload.storage_path)) {
    try {
      const reports = parseUploadedFile(fs.readFileSync(upload.storage_path), upload.file_name, upload.file_type, { selectedPeriod: period, requestedReportType: revenueStatisticsReportType });
      refreshed = reports[revenueStatisticsReportType] || refreshed;
    } catch {}
  }
  revenueStatisticsRefreshCache.set(revenue.meta.uploadKey, refreshed);
  return refreshed;
};
const consultantPayrollRefreshCache = new Map();
const refreshedConsultantPayrollRawFor = (payroll, period) => {
  if (Object.prototype.hasOwnProperty.call(payroll.raw?.fieldMapping || {}, 'hireDate') || !payroll.meta?.uploadKey) return payroll.raw;
  if (consultantPayrollRefreshCache.has(payroll.meta.uploadKey)) return consultantPayrollRefreshCache.get(payroll.meta.uploadKey);
  const upload = db.prepare('SELECT file_name, file_type, storage_path FROM upload_batches WHERE upload_key = ?').get(payroll.meta.uploadKey); let refreshed = payroll.raw;
  if (upload?.storage_path && fs.existsSync(upload.storage_path)) {
    try {
      const reports = parseUploadedFile(fs.readFileSync(upload.storage_path), upload.file_name, upload.file_type, { selectedPeriod: period, requestedReportType: payrollStatementReportType });
      refreshed = reports[payrollStatementReportType] || refreshed;
    } catch {}
  }
  consultantPayrollRefreshCache.set(payroll.meta.uploadKey, refreshed); return refreshed;
};
const consultantRoiAnalysisFor = (employeeKey, period) => {
  const payroll = rawReportFor(payrollStatementReportType, 'group', period); const revenue = rawReportFor(revenueStatisticsReportType, 'group', period);
  const payrollRaw = refreshedConsultantPayrollRawFor(payroll, period); const payrollRows = payrollRaw?.payrollRows || []; const consultantPayrollRows = payrollRows.filter(item => consultantDepartmentMatches(item.department)); const revenueRaw = refreshedRevenueStatisticsRawFor(revenue, period); const revenueRows = revenueRaw?.consultantRevenue?.rows || [];
  const consultants = new Map();
  const ensure = (canonicalName, displayName) => { if (!consultants.has(canonicalName)) consultants.set(canonicalName, { canonicalName, name: displayName || canonicalName, regions: new Set(), hireDates: new Set(), baseSalary: 0, commission: 0, journalExpense: 0, expectedRevenue: 0, payrollDetails: [], revenueDetails: [], expenseDetails: [] }); return consultants.get(canonicalName); };
  for (const item of consultantPayrollRows) {
    const row = ensure(item.canonicalName || consultantCanonicalName(item.name), item.name);
    row.baseSalary += Number(item.baseSalary || 0); row.commission += Number(item.commission || 0); if (item.hireDate) row.hireDates.add(item.hireDate);
    row.payrollDetails.push({ sourceSheet: payrollRaw.sourceSheet, row: item.row, company: item.company || '', department: item.department || '', hireDate: item.hireDate || '', baseSalary: item.baseSalary, commission: item.commission });
  }
  let unmatchedRevenueRows = 0; let unmatchedRevenueAmount = 0;
  for (const item of revenueRows) {
    const row = consultants.get(item.canonicalName || consultantCanonicalName(item.consultant));
    if (!row) { unmatchedRevenueRows += 1; unmatchedRevenueAmount += Number(item.expectedRevenue || 0); continue; }
    row.expectedRevenue += Number(item.expectedRevenue || 0); if (item.region) row.regions.add(item.region); row.revenueDetails.push({ sourceSheet: revenueRaw.consultantRevenue?.sourceSheet, row: item.row, expectedRevenue: item.expectedRevenue, region: item.region, sourcePeriod: item.sourcePeriod || period });
  }
  const profile = permissionProfileFor(employeeKey); const sourceCompanies = authorizedCompaniesFor(employeeKey).filter(company => company.key !== 'group' && profileScopeAllows(profile, company.key, period)); const journalSources = [];
  for (const company of sourceCompanies) {
    const journal = rawReportFor('journal', company.key, period); journalSources.push({ companyKey: company.key, companyName: company.name, ...journal.meta }); if (journal.meta.noData) continue;
    const raw = journal.raw; const summaryIndex = journalColumnIndex(raw, '摘要', 2); const accountIndex = journalColumnIndex(raw, '科目名称', 4); const debitIndex = journalColumnIndex(raw, '借方金额', 5); const creditIndex = journalColumnIndex(raw, '贷方金额', 6); const voucherIndex = journalColumnIndex(raw, '凭证号', 1);
    const rows = withoutProfitClosingEntries(raw.rows || [], row => row.cells?.[summaryIndex], row => row.cells?.[voucherIndex]);
    for (const sourceRow of rows) {
      const cells = sourceRow.cells || []; const account = String(cells[accountIndex] || '').trim(); const summary = String(cells[summaryIndex] || '').trim();
      if (!/^(?:销售费用|管理费用)(?:[-—－]|$)/.test(account) || /工资|薪酬|提成/.test(`${account}${summary}`)) continue;
      const searchable = `${summary}${account}`.replace(/\s+/g, '').toLowerCase(); const matched = [...consultants.values()].filter(item => item.canonicalName.length >= 2 && searchable.includes(item.canonicalName.toLowerCase()));
      if (matched.length !== 1) continue;
      const amount = Number(cells[debitIndex] || 0) - Number(cells[creditIndex] || 0); if (Math.abs(amount) < 0.000001) continue;
      matched[0].journalExpense += amount; matched[0].expenseDetails.push({ companyKey: company.key, companyName: company.name, row: sourceRow.row, date: journalDateFor(sourceRow), voucher: String(cells[voucherIndex] || ''), summary, account, amount: roundedAmount(amount) });
    }
  }
  const rows = [...consultants.values()].map(item => {
    const input = roundedAmount(item.baseSalary + item.commission + item.journalExpense); const output = roundedAmount(item.expectedRevenue); const hireDate = [...item.hireDates].sort()[0] || '';
    return { name: item.name, canonicalName: item.canonicalName, region: [...item.regions].join('、') || '待补充', hireDate, isNewEmployee: Boolean(hireDate && hireDate.slice(0, 7) === period), baseSalary: roundedAmount(item.baseSalary), commission: roundedAmount(item.commission), journalExpense: roundedAmount(item.journalExpense), input, output, roi: input ? output / input : null, matchStatus: item.payrollDetails.length && item.revenueDetails.length ? 'matched' : item.payrollDetails.length ? 'missing_revenue' : 'missing_payroll', payrollDetails: item.payrollDetails, revenueDetails: item.revenueDetails, expenseDetails: item.expenseDetails };
  }).sort((a, b) => b.output - a.output || b.input - a.input);
  const totals = rows.reduce((sum, row) => ({ input: sum.input + row.input, output: sum.output + row.output, baseSalary: sum.baseSalary + row.baseSalary, commission: sum.commission + row.commission, journalExpense: sum.journalExpense + row.journalExpense }), { input: 0, output: 0, baseSalary: 0, commission: 0, journalExpense: 0 });
  Object.keys(totals).forEach(key => { totals[key] = roundedAmount(totals[key]); }); totals.roi = totals.input ? totals.output / totals.input : null;
  const sourceRevision = crypto.createHash('sha256').update(JSON.stringify({ schema: 3, payroll: [payroll.meta.uploadKey, payroll.meta.publishedAt], revenue: [revenue.meta.uploadKey, revenue.meta.publishedAt], journals: journalSources.map(item => [item.companyKey, item.uploadKey, item.publishedAt]) })).digest('hex').slice(0, 20);
  const consultantDepartments = [...new Set(consultantPayrollRows.map(item => String(item.department || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return { company: '桉侨集团', period, sourceRevision, rows, totals, sources: { payroll: payroll.meta, payrollSheet: payrollRaw?.sourceSheet || '', payrollFields: payrollRaw?.fieldMapping || {}, payrollConsultantDepartments: consultantDepartments, payrollConsultantRows: consultantPayrollRows.length, payrollExcludedRows: Math.max(0, payrollRows.length - consultantPayrollRows.length), revenue: revenue.meta, revenueSheet: revenueRaw?.consultantRevenue?.sourceSheet || '', revenueFields: revenueRaw?.consultantRevenue?.fieldMapping || {}, revenueExcludedPeriodRows: Number(revenueRaw?.consultantRevenue?.excludedPeriodRows || 0), unmatchedRevenueRows, unmatchedRevenueAmount: roundedAmount(unmatchedRevenueAmount), journals: journalSources }, missing: [payroll.meta.noData ? '每月工资表' : '', !payroll.meta.noData && !consultantPayrollRows.length ? '工资表·顾问部门人员' : '', revenue.meta.noData || !revenueRows.length ? '营收统计表·总营收明细表' : '', ...journalSources.filter(item => item.noData).map(item => `${item.companyName}序时账`)].filter(Boolean) };
};
const briefLineName = value => String(value || '')
  .replace(/\s+/g, '')
  .replace(/^[一二三四五六七八九十]+、/, '')
  .replace(/^(?:加|减|其中)[：:]/, '')
  .replace(/[（(].*$/, '')
  .trim();
const briefStatementAmount = (raw, target) => {
  const rows = raw?.rows || [];
  const header = rows.find(row => (row.cells || []).some(value => /本期金额|期末余额/.test(String(value || ''))));
  const currentIndex = (header?.cells || []).findIndex(value => /本期金额|期末余额/.test(String(value || '')));
  const row = rows.find(item => (item.cells || []).some(value => typeof value === 'string' && briefLineName(value) === target));
  if (!row) return null;
  if (currentIndex >= 0 && Number.isFinite(Number(row.cells?.[currentIndex]))) return Number(row.cells[currentIndex]);
  const numbers = (row.cells || []).filter(value => typeof value === 'number' && Number.isFinite(value));
  return numbers.length ? numbers.at(-1) : null;
};
const briefNumericAmount = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const source = String(value ?? '').trim();
  if (!source || !/\d/.test(source)) return null;
  const parenthesized = /^\(.*\)$/.test(source);
  const normalized = source.replace(/[￥¥元,，\s]/g, '').replace(/^\((.*)\)$/, '$1');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? (parenthesized ? -amount : amount) : null;
};
const briefForecastAmount = raw => {
  const rows = raw?.rows || [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const cells = rows[rowIndex].cells || [];
    const directIndex = cells.findIndex(value => /预计营收/.test(String(value || '')));
    if (directIndex >= 0) {
      const number = cells.slice(directIndex + 1).map(briefNumericAmount).find(value => value !== null);
      if (number !== undefined) return number;
    }
    const markerIndex = cells.findIndex(value => String(value || '').trim() === '当月营收利润');
    if (markerIndex >= 0) {
      const number = rows.slice(rowIndex + 1).map(row => briefNumericAmount(row.cells?.[markerIndex])).find(value => value !== null);
      if (number !== undefined) return number;
    }
  }
  return null;
};
const briefCompanyAliases = value => {
  const full = String(value || '').replace(/桉桥/g, '桉侨').replace(/[\s市]/g, '').replace(/[（(].*?[）)]/g, '');
  const withoutSuffix = full.replace(/(?:有限责任公司|有限公司|公司)$/, '');
  const brand = withoutSuffix.match(/^.*?(?:桉侨|侨桉)/)?.[0] || '';
  return [...new Set([full, withoutSuffix, brand].filter(alias => alias.length >= 2))];
};
const briefCompanyAlias = value => briefCompanyAliases(value).at(-1) || '';
const briefEntityForCompany = (raw, company) => {
  const wanted = briefCompanyAliases(company?.company_name);
  const ranked = (raw?.entities || []).map((entity, index) => {
    const candidates = [...new Set([entity.companyName, entity.sourceSheet].flatMap(briefCompanyAliases))];
    const exact = candidates.some(candidate => wanted.includes(candidate));
    const contained = candidates.some(candidate => wanted.some(alias => Math.min(candidate.length, alias.length) >= 4 && (candidate.includes(alias) || alias.includes(candidate))));
    const region = candidates.some(candidate => wanted.some(alias => candidate.slice(0, 2) === alias.slice(0, 2)));
    return { entity, index, score: exact ? 3 : contained ? 2 : region ? 1 : 0 };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score && ranked[0].score === 1)) return null;
  return ranked[0].entity;
};
const briefAdvertisingForCompany = (companyKey, period) => {
  const trial = rawReportFor('trial_balance', companyKey, period);
  if (trial.meta.noData) return { available: false, amount: null, source: '', sourceSheet: '', report: '科目余额表' };
  const header = (trial.raw.rows || []).find(row => (row.cells || []).some(value => String(value || '').trim() === '本期发生额'));
  const currentDebitIndex = (header?.cells || []).findIndex(value => String(value || '').trim() === '本期发生额');
  if (currentDebitIndex < 0) return { available: false, amount: null, source: trial.meta.fileName, sourceSheet: trial.raw.sourceSheet || '科目余额表', report: '科目余额表' };
  const matched = (trial.raw.rows || []).map(row => ({ row, code: String(row.cells?.[0] || '').trim(), name: String(row.cells?.[1] || '').trim() }))
    .filter(item => /广宣费|广告费|业务宣传费|宣传费/.test(item.name));
  const leaves = matched.filter(item => !matched.some(other => other !== item && item.code && other.code.startsWith(item.code) && other.code.length > item.code.length));
  const debitAmount = roundedAmount(leaves.reduce((sum, item) => sum + (briefNumericAmount(item.row.cells?.[currentDebitIndex]) ?? 0), 0));
  return { available: true, amount: debitAmount, source: trial.meta.fileName, sourceSheet: trial.raw.sourceSheet || '科目余额表', report: '科目余额表' };
};
const financialBriefFor = (companyKey, period) => {
  const company = companyRow(companyKey);
  const groupRevenue = rawReportFor(revenueProfitReportType, 'group', period);
  const revenueRaw = companyKey === 'group' ? groupRevenue.raw : briefEntityForCompany(groupRevenue.raw, company);
  const standard = rawReportFor(companyKey === 'group' ? 'consolidated_income_statement' : 'income_statement', companyKey, period);
  const sources = []; const missing = [];
  const addSource = (report, fileName, scope = '', category = 'general') => { if (fileName && !sources.some(item => item.report === report && item.fileName === fileName && item.scope === scope && item.category === category)) sources.push({ report, fileName, scope, category }); };
  if (!groupRevenue.meta.noData && revenueRaw) addSource('（营收利润口径）合并利润表', groupRevenue.meta.fileName, companyKey === 'group' ? '集团' : company.company_name);
  else if (groupRevenue.meta.noData) missing.push('（营收利润口径）合并利润表');
  else missing.push(`（营收利润口径）合并利润表未找到${company.company_name}对应工作表`);
  if (!standard.meta.noData) addSource(companyKey === 'group' ? '桉侨集团合并利润表' : '利润表', standard.meta.fileName, company.company_name);
  else missing.push(companyKey === 'group' ? '桉侨集团合并利润表' : '利润表');
  let accountBalance = null; let advertisingExpense = null;
  if (companyKey !== 'group') {
    const balance = rawReportFor('balance_sheet', companyKey, period);
    const advertising = briefAdvertisingForCompany(companyKey, period);
    if (!balance.meta.noData) { accountBalance = briefStatementAmount(balance.raw, '货币资金'); addSource('资产负债表', balance.meta.fileName, company.company_name); }
    else missing.push(`账户余额来源缺少：${company.company_name}（资产负债表）`);
    if (advertising.available) advertisingExpense = advertising.amount;
    else missing.push(`广宣费来源缺少：${company.company_name}（科目余额表）`);
  } else {
    const entities = (groupRevenue.raw?.entities || []).map(entity => ({ entity, alias: briefCompanyAlias(entity.companyName || entity.sourceSheet) }));
    companyOrderFor();
    const companies = db.prepare("SELECT c.company_key, c.company_name FROM company_display_order o JOIN companies c ON c.company_key = o.company_key WHERE c.company_key <> 'group' ORDER BY o.sort_order, c.company_key").all();
    const expected = entities.length ? companies.filter(item => entities.some(({ alias }) => alias && (alias.includes(briefCompanyAlias(item.company_name)) || briefCompanyAlias(item.company_name).includes(alias)))) : companies;
    let balanceTotal = 0; let advertisingTotal = 0; let balanceComplete = expected.length > 0; let advertisingComplete = expected.length > 0;
    const balanceMissingCompanies = []; const advertisingMissingCompanies = [];
    for (const item of expected) {
      const balance = rawReportFor('balance_sheet', item.company_key, period); const advertising = briefAdvertisingForCompany(item.company_key, period);
      if (balance.meta.noData) { balanceComplete = false; balanceMissingCompanies.push(item.company_name); }
      else { const amount = briefStatementAmount(balance.raw, '货币资金'); if (amount === null) { balanceComplete = false; balanceMissingCompanies.push(item.company_name); } else balanceTotal += amount; addSource('资产负债表', balance.meta.fileName, item.company_name); }
      if (!advertising.available) { advertisingComplete = false; advertisingMissingCompanies.push(item.company_name); }
      else advertisingTotal += advertising.amount;
    }
    if (balanceComplete) accountBalance = roundedAmount(balanceTotal); else missing.push(`账户余额来源缺少：${balanceMissingCompanies.join('、') || '尚未识别集团子公司'}（资产负债表）`);
    if (advertisingComplete) advertisingExpense = roundedAmount(advertisingTotal); else missing.push(`广宣费来源缺少：${advertisingMissingCompanies.join('、') || '尚未识别集团子公司'}（科目余额表）`);
  }
  const valueOrNull = (raw, name) => raw ? briefStatementAmount(raw, name) : null;
  const metrics = {
    expectedRevenue: revenueRaw ? briefForecastAmount(revenueRaw) : null,
    accountBalance,
    operatingRevenue: standard.meta.noData ? null : valueOrNull(standard.raw, '营业收入'),
    operatingCost: standard.meta.noData ? null : valueOrNull(standard.raw, '营业成本'),
    sellingExpense: standard.meta.noData ? null : valueOrNull(standard.raw, '销售费用'),
    advertisingExpense,
    managementExpense: standard.meta.noData ? null : valueOrNull(standard.raw, '管理费用'),
    financeExpense: standard.meta.noData ? null : valueOrNull(standard.raw, '财务费用'),
    netProfit: standard.meta.noData ? null : valueOrNull(standard.raw, '净利润'),
    comprehensiveRevenueProfit: revenueRaw ? valueOrNull(revenueRaw, '净利润') : null
  };
  for (const [key, label] of Object.entries({ expectedRevenue: '预计营收', accountBalance: '账户余额', operatingRevenue: '营业收入', operatingCost: '营业成本', sellingExpense: '销售费用', advertisingExpense: '广宣费', managementExpense: '管理费用', financeExpense: '财务费用', netProfit: '净利润', comprehensiveRevenueProfit: '营收综合利润' })) if (metrics[key] === null && !missing.some(item => item === label || item.startsWith(`${label}来源`))) missing.push(label);
  return { company: company.company_name, companyKey, period, scopeLabel: companyKey === 'group' ? '集团方面' : `${company.company_name}方面`, metrics, sources, missing: [...new Set(missing)], complete: missing.length === 0 };
};
const financialBriefItemRow = itemKey => db.prepare(`SELECT n.note_key AS itemKey, n.company_key AS companyKey, n.period, n.metric_key AS metricKey, n.item_name AS name, n.item_amount AS amount, n.created_by AS createdBy, e.display_name AS authorName, n.created_at AS createdAt, n.updated_at AS updatedAt
  FROM financial_brief_notes n JOIN employees e ON e.employee_key = n.created_by WHERE n.note_key = ?`).get(itemKey);
const financialBriefItemsFor = (companyKey, period) => db.prepare(`SELECT n.note_key AS itemKey, n.metric_key AS metricKey, n.item_name AS name, n.item_amount AS amount, n.created_by AS createdBy, e.display_name AS authorName, n.created_at AS createdAt, n.updated_at AS updatedAt
  FROM financial_brief_notes n JOIN employees e ON e.employee_key = n.created_by WHERE n.company_key = ? AND n.period = ? AND n.metric_key != 'comprehensiveRevenueProfit' ORDER BY n.metric_key, n.created_at, n.note_key`).all(companyKey, period);
const normalizeFinancialBriefItemName = value => String(value || '').replace(/\s+/g, ' ').trim();
const normalizeFinancialBriefItemAmount = value => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const amount = Number(String(value).replace(/[,，\s￥¥元]/g, ''));
  return Number.isFinite(amount) && Math.abs(amount) <= 1_000_000_000_000_000 ? Number(amount.toFixed(2)) : null;
};
const sendStatic = (req, res, pathname) => {
  const safe = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''); const file = path.resolve(publicDir, safe);
  const relative = path.relative(publicDir, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return bad(res, 403, '禁止访问');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return text(res, 404, 'Not found');
  const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.png') ? 'image/png' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.webp') ? 'image/webp' : file.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream';
  const sharePageUrl = publicBaseUrl ? `${publicBaseUrl}/` : `${appBasePath || ''}/`;
  const shareImageUrl = publicBaseUrl ? `${publicBaseUrl}/anqiao-logo.png` : `${appBasePath || ''}/anqiao-logo.png`;
  const body = file.endsWith('.html') ? fs.readFileSync(file, 'utf8').replaceAll('__APP_BASE_PATH__', appBasePath).replaceAll('__PORTAL_HOME_URL__', portalHomeUrl).replaceAll('__PLATFORM_LOGIN_URL__', platformLoginUrl).replaceAll('__SHARE_PAGE_URL__', sharePageUrl).replaceAll('__SHARE_IMAGE_URL__', shareImageUrl) : fs.readFileSync(file);
  text(res, 200, body, type);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  applySecurityHeaders(res);
  try {
    if (url.pathname.startsWith('/api/') && !isAllowedApiRequestSource(req)) return bad(res, 403, '请求来源不允许访问财务接口');
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, version: appVersion, authMode, name: '桉侨集团财务报表看板' });
    if (url.pathname === '/auth/wecom' || url.pathname === '/auth/wecom/callback') return redirect(res, authMode === 'platform' ? platformLoginUrl : appPath('/'));
    if (url.pathname === '/auth/logout') return redirect(res, authMode === 'platform' ? platformLoginUrl : appPath('/'), { 'set-cookie': clearSessionCookie() });
    if (url.pathname === '/api/auth/platform-session' && req.method === 'POST') {
      if (authMode !== 'platform') return bad(res, 404, '当前环境未启用小Q统一认证');
      const accessToken = parseBearerToken(req.headers.authorization);
      if (!accessToken) return json(res, 401, { error: '缺少小Q登录凭证', loginUrl: platformLoginUrl });
      try {
        const [profile, rolePayload] = await Promise.all([
          platformJson('/auth/me', accessToken),
          platformJson('/data-dist/my-roles', accessToken),
        ]);
        const platformRoles = Array.isArray(rolePayload) ? rolePayload : rolePayload?.roles;
        const identity = normalizePlatformIdentity(profile, platformRoles);
        if (!identity || !hasFinancePlatformAccess(identity.roles)) return bad(res, 403, accessDeniedMessage);
        if (identity.roles.includes('admin')) {
          try {
            const groups = await platformJson('/data-dist/user-groups', accessToken);
            syncPlatformDirectory(groups, identity.employeeKey);
          } catch (error) {
            const message = String(error?.message || '小Q成员目录同步失败').slice(0, 300);
            const previous = directorySyncState();
            db.prepare("INSERT INTO directory_sync_state(source, status, last_attempt_at, last_error, employee_count) VALUES ('platform', 'failed', ?, ?, ?) ON CONFLICT(source) DO UPDATE SET status = 'failed', last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error").run(now(), message, Number(previous.employeeCount || 0));
          }
        }
        const employee = upsertPlatformEmployee(identity);
        log(employee.employee_key, 'platform_login', employee.employee_key, `小Q统一登录：${identity.roles.join(',')}`, { moduleKey: 'home' });
        return json(res, 200, { ok: true, employee: { key: employee.employee_key, name: employee.display_name }, roles: identity.roles }, { 'set-cookie': sessionCookie(employee.employee_key) });
      } catch (error) {
        if (error instanceof PlatformApiError && error.status === 401) return json(res, 401, { error: error.message, loginUrl: platformLoginUrl });
        if (error instanceof PlatformApiError && error.status === 403) return bad(res, 403, accessDeniedMessage);
        return bad(res, 502, '暂时无法连接小Q认证服务，请稍后重试');
      }
    }
    if (!url.pathname.startsWith('/api/')) {
      return sendStatic(req, res, url.pathname);
    }
    if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
      const employee = requireEmployee(req, res); if (!employee) return;
      const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06';
      const roleNames = rolesFor(employee.employee_key).map(r => r.role_name);
      const permissionProfile = permissionProfileFor(employee.employee_key); const authorizedCompanies = authorizedCompaniesFor(employee.employee_key); const hasDataScope = authorizedCompanies.length > 0;
      const reportTypes = db.prepare('SELECT report_type AS key, report_name AS name FROM report_types ORDER BY rowid').all();
      const canViewDetails = hasModule(employee.employee_key, 'report_detail', 'view');
      const reportDetailAccess = Object.fromEntries(reportTypes.map(item => [item.key, canViewDetails && hasReport(employee.employee_key, item.key, 'detail', 'view', companyKey, period)]));
      const consolidatedEntitiesByReport = Object.fromEntries([...groupStatementReportTypes].map(type => [type, consolidatedEntitiesFor(type, companyKey, period, employee.employee_key)]));
      return json(res, 200, { appVersion, authMode, employee: { key: employee.employee_key, name: employee.display_name, department: employee.department }, roles: roleNames, reportWatermarkEnabled: reportWatermarkEnabled(), reportDetailAccess, canManagePermissions: hasModule(employee.employee_key, 'permission_admin', 'manage'), canManageReportData: hasDataScope && hasModule(employee.employee_key, 'database_admin', 'view'), canCreateCompanies: hasModule(employee.employee_key, 'permission_admin', 'manage') && permissionProfile.companyKeys.includes('*'), canReorderCompanies: hasModule(employee.employee_key, 'permission_admin', 'manage') && permissionProfile.companyKeys.includes('*'), canUploadReports: hasDataScope && hasModule(employee.employee_key, 'report_import', 'upload'), canPublishReports: hasDataScope && hasModule(employee.employee_key, 'report_import', 'publish'), availablePeriodsByCompany: availablePeriodsByCompanyFor(employee.employee_key), employees: authMode === 'demo' ? db.prepare('SELECT employee_key AS key, display_name AS name, department FROM employees WHERE active = 1 ORDER BY employee_key').all() : [{ key: employee.employee_key, name: employee.display_name, department: employee.department }], companies: authorizedCompanies, reportTypes, modules: visibleModulesFor(employee.employee_key, companyKey, period), consolidatedEntities: consolidatedEntitiesByReport.consolidated_income_statement, consolidatedEntitiesByReport, moduleOrder: moduleOrderFor(), analysisBlockOrder: allAnalysisBlockOrders(), analysisBlockAccess: analysisBlockAccessFor(employee.employee_key, companyKey, period) });
    }
    if (url.pathname === '/api/activity/page-view' && req.method === 'POST') {
      const employee = requireEmployee(req, res); if (!employee) return;
      const body = await parseBody(req); const moduleKey = String(body.moduleKey || '').trim(); const companyKey = String(body.companyKey || '').trim(); const period = String(body.period || '').trim();
      const allowed = new Set(visibleModulesFor(employee.employee_key, companyKey || 'gz', period || '2026-06').map(item => item.key));
      if (moduleKey === 'journal_detail' && hasModule(employee.employee_key, 'report_detail', 'view')) allowed.add(moduleKey);
      if (!moduleKey || moduleKey.length > 100 || !allowed.has(moduleKey)) return bad(res, 400, '浏览模块无效或当前员工不可见');
      const detail = String(body.detail || moduleNames.get(moduleKey) || moduleKey).slice(0, 300);
      log(employee.employee_key, 'browse_page', moduleKey, detail, { logType: 'browse', moduleKey, companyKey, period });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/admin/activity-logs' && req.method === 'GET') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '只有管理员可以查看浏览日志'); return; }
      const filters = Object.fromEntries(['employeeKey', 'logType', 'action', 'moduleKey', 'companyKey', 'period', 'startAt', 'endAt', 'search'].map(key => [key, String(url.searchParams.get(key) || '').trim()]));
      if (filters.logType && !['browse', 'operation'].includes(filters.logType)) return bad(res, 400, '日志类型无效');
      if (filters.period && !/^\d{4}-\d{2}$/.test(filters.period)) return bad(res, 400, '会计期间无效');
      if ([filters.startAt, filters.endAt].some(value => value && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))))) return bad(res, 400, '日志时间范围无效');
      if (filters.search.length > 100) return bad(res, 400, '搜索关键词不能超过 100 个字符');
      const page = Math.max(1, Number(url.searchParams.get('page') || 1)); const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') || 20)));
      const where = activityLogWhere(filters);
      const stats = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN a.log_type = 'browse' THEN 1 ELSE 0 END), 0) AS browse, COALESCE(SUM(CASE WHEN a.log_type = 'operation' THEN 1 ELSE 0 END), 0) AS operation FROM audit_logs a LEFT JOIN employees e ON e.employee_key = a.employee_key WHERE ${where.sql}`).get(...where.args);
      const items = db.prepare(`SELECT a.audit_key AS auditKey, a.employee_key AS employeeKey, COALESCE(e.display_name, a.employee_key) AS employeeName, COALESCE(e.department, '') AS department, a.log_type AS logType, a.action, a.target, a.detail, a.module_key AS moduleKey, a.company_key AS companyKey, COALESCE(c.company_name, '') AS companyName, a.period, a.created_at AS createdAt FROM audit_logs a LEFT JOIN employees e ON e.employee_key = a.employee_key LEFT JOIN companies c ON c.company_key = a.company_key WHERE ${where.sql} ORDER BY a.created_at DESC, a.audit_key DESC LIMIT ? OFFSET ?`).all(...where.args, pageSize, (page - 1) * pageSize).map(item => ({ ...item, actionName: auditActionName(item.action), moduleName: moduleNames.get(item.moduleKey) || item.moduleKey }));
      const employees = db.prepare('SELECT DISTINCT a.employee_key AS key, COALESCE(e.display_name, a.employee_key) AS name, COALESCE(e.department, \'\') AS department FROM audit_logs a LEFT JOIN employees e ON e.employee_key = a.employee_key ORDER BY name').all();
      const actions = db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all().map(item => ({ key: item.action, name: auditActionName(item.action) }));
      const modules = db.prepare("SELECT DISTINCT module_key AS key FROM audit_logs WHERE module_key <> '' ORDER BY module_key").all().map(item => ({ ...item, name: moduleNames.get(item.key) || item.key }));
      const companies = db.prepare('SELECT company_key AS key, company_name AS name FROM companies ORDER BY company_name').all();
      return json(res, 200, { items, page, pageSize, total: Number(stats.total), stats: { total: Number(stats.total), browse: Number(stats.browse), operation: Number(stats.operation) }, filters: { employees, actions, modules, companies } });
    }
    if (url.pathname === '/api/admin/activity-logs' && req.method === 'DELETE') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '只有管理员可以管理浏览日志'); return; }
      const body = await parseBody(req); const auditKeys = [...new Set((Array.isArray(body.auditKeys) ? body.auditKeys : []).map(Number).filter(key => Number.isSafeInteger(key) && key > 0))];
      if (!auditKeys.length || auditKeys.length > 500) return bad(res, 400, '请选择 1 至 500 条有效日志');
      const placeholders = auditKeys.map(() => '?').join(','); const removed = db.prepare(`DELETE FROM audit_logs WHERE audit_key IN (${placeholders})`).run(...auditKeys).changes;
      log(employee.employee_key, 'delete_activity_logs', activityLogModuleKey, `removed=${removed};selected=${auditKeys.length}`, { moduleKey: activityLogModuleKey });
      return json(res, 200, { ok: true, removed });
    }
    if (url.pathname === '/api/admin/report-watermark' && req.method === 'POST') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '没有权限修改员工水印设置'); return; }
      const body = await parseBody(req);
      if (typeof body.enabled !== 'boolean') return bad(res, 400, '员工水印开关必须是布尔值');
      saveAppSetting('report_watermark_enabled', body.enabled ? '1' : '0', employee.employee_key);
      log(employee.employee_key, 'set_report_watermark', 'app_settings', `enabled=${body.enabled}`, { moduleKey: 'permissions' });
      return json(res, 200, { enabled: reportWatermarkEnabled() });
    }
    if (url.pathname === '/api/admin/companies' && req.method === 'POST') {
      const employee = requireEmployee(req, res); if (!employee) return;
      const profile = permissionProfileFor(employee.employee_key);
      if (!hasModule(employee.employee_key, 'permission_admin', 'manage') || !profile.companyKeys.includes('*')) return bad(res, 403, '只有拥有全部公司范围的权限管理员可以新增公司');
      const body = await parseBody(req); const name = String(body.name || '').trim().replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 40) return bad(res, 400, '公司名称需为 2 至 40 个字符');
      if (db.prepare('SELECT 1 FROM companies WHERE lower(company_name) = lower(?)').get(name)) return bad(res, 409, '该公司已存在');
      const companyKey = `co-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
      db.prepare('INSERT INTO companies(company_key, company_name) VALUES (?, ?)').run(companyKey, name);
      log(employee.employee_key, 'create_company', companyKey, name, { moduleKey: 'uploads', companyKey });
      return json(res, 201, { company: { key: companyKey, name } });
    }
    if (url.pathname === '/api/uploads' && req.method === 'GET') {
      const employee = requireImport(req, res, 'upload'); if (!employee) return;
      const companyKey = String(url.searchParams.get('company') || '').trim(); const period = String(url.searchParams.get('period') || '').trim();
      const reportType = String(url.searchParams.get('reportType') || '').trim(); const search = String(url.searchParams.get('search') || '').trim().slice(0, 80);
      const view = String(url.searchParams.get('view') || 'all').trim(); const page = Math.max(1, Number(url.searchParams.get('page') || 1) || 1);
      const pageSize = url.searchParams.has('pageSize') ? Math.min(50, Math.max(5, Number(url.searchParams.get('pageSize')) || 10)) : 200;
      if (period && !/^\d{4}-\d{2}$/.test(period)) return bad(res, 400, '上传历史期间格式无效');
      if (reportType && !reportTypeRow(reportType)) return bad(res, 400, '上传历史报表类型无效');
      if (!['all', 'pending', 'versions'].includes(view)) return bad(res, 400, '上传历史视图无效');
      const profile = permissionProfileFor(employee.employee_key); const scopeConditions = ['period >= ?', 'period <= ?']; const scopeArgs = [profile.fromPeriod, profile.toPeriod];
      if (!profile.companyKeys.includes('*')) {
        const companyKeys = profile.companyKeys.filter(key => companyRow(key));
        if (companyKeys.length) { scopeConditions.push(`company_key IN (${companyKeys.map(() => '?').join(',')})`); scopeArgs.push(...companyKeys); }
        else scopeConditions.push('0=1');
      }
      const scopeWhere = `WHERE ${scopeConditions.join(' AND ')}`;
      const conditions = [...scopeConditions]; const args = [...scopeArgs];
      if (companyKey) { conditions.push('company_key = ?'); args.push(companyKey); }
      if (period) { conditions.push('period = ?'); args.push(period); }
      if (reportType) { conditions.push('report_type = ?'); args.push(reportType); }
      if (search) { conditions.push('(file_name LIKE ? OR upload_key LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
      const baseWhere = `WHERE ${conditions.join(' AND ')}`;
      const counts = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status NOT IN ('published','superseded') THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS current, SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS history FROM upload_batches ${baseWhere}`).get(...args);
      const viewCondition = view === 'pending' ? "status NOT IN ('published','superseded')" : view === 'versions' ? "status IN ('published','superseded')" : '';
      const viewWhere = viewCondition ? `${baseWhere} AND ${viewCondition}` : baseWhere;
      const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM upload_batches ${viewWhere}`).get(...args).count || 0);
      const totalPages = Math.max(1, Math.ceil(total / pageSize)); const effectivePage = Math.min(page, totalPages);
      const query = `SELECT upload_key AS uploadKey, employee_key AS employeeKey, company_key AS companyKey, period, report_type AS reportType, file_name AS fileName, file_type AS fileType, content_hash AS contentHash, status, validation_message AS validationMessage, created_at AS createdAt, published_at AS publishedAt, notes FROM upload_batches ${viewWhere} ORDER BY period DESC, company_key, created_at DESC LIMIT ? OFFSET ?`;
      const uploads = db.prepare(query).all(...args, pageSize, (effectivePage - 1) * pageSize).map(item => ({ ...item, canDelete: canDeleteUpload(employee.employee_key, item) }));
      const filterOptions = { periods: db.prepare(`SELECT DISTINCT period FROM upload_batches ${scopeWhere} ORDER BY period DESC`).all(...scopeArgs).map(item => item.period), reportTypes: db.prepare(`SELECT DISTINCT report_type AS reportType FROM upload_batches ${scopeWhere} ORDER BY report_type`).all(...scopeArgs).map(item => item.reportType) };
      return json(res, 200, { uploads, total, page: effectivePage, pageSize, summary: { total: Number(counts.total || 0), pending: Number(counts.pending || 0), current: Number(counts.current || 0), history: Number(counts.history || 0) }, filterOptions });
    }
    if (url.pathname === '/api/uploads' && req.method === 'POST') {
      const employee = requireImport(req, res, 'upload'); if (!employee) return;
      const body = await parseBody(req); const { companyKey, period, reportType = '', fileName, fileType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64, notes = '' } = body;
      const uploadIssues = []; const uploadIssueFields = [];
      if (!companyKey) { uploadIssues.push('未选择上传公司'); uploadIssueFields.push('companyKey'); }
      else if (!companyRow(companyKey)) { uploadIssues.push('上传公司不存在或已失效'); uploadIssueFields.push('companyKey'); }
      if (!/^\d{4}-\d{2}$/.test(String(period || ''))) { uploadIssues.push(period ? '报表期间格式无效' : '未选择报表期间'); uploadIssueFields.push('period'); }
      if (reportType && !reportTypeRow(reportType)) { uploadIssues.push('报表类型不存在或已失效'); uploadIssueFields.push('reportType'); }
      if (!fileName) { uploadIssues.push('未传入文件名称'); uploadIssueFields.push('fileName'); }
      if (!contentBase64) { uploadIssues.push('未传入文件内容，请重新选择文件'); uploadIssueFields.push('contentBase64'); }
      if (uploadIssues.length) return bad(res, 400, `上传信息不完整：${uploadIssues.join('；')}`, { code: 'UPLOAD_REQUEST_INVALID', fields: [...new Set(uploadIssueFields)] });
      if (!importScopeAllows(employee, res, companyKey, period)) return;
      const buffer = Buffer.from(String(contentBase64).replace(/^data:[^;]+;base64,/, ''), 'base64'); if (!buffer.length) return bad(res, 400, '文件内容为空');
      const bundleKey = `upl-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`; const safeName = path.basename(String(fileName)).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_'); const storagePath = path.join(uploadsDir, `${bundleKey}-${safeName}`); const rawPath = path.join(uploadsDir, `${bundleKey}.json`);
      let reports; try { reports = parseUploadedFile(buffer, safeName, fileType, { selectedPeriod: period, requestedReportType: reportType }); } catch (error) { return bad(res, 400, `文件解析失败：${error.message}`); }
      const companyHint = uploadCompanyHint(safeName, reports);
      if (companyHint.conflict) return json(res, 409, { error: '文件名或报表内容中检测到多个公司地区，请核对原始文件后再上传', code: 'COMPANY_HINT_CONFLICT', selectedCompanyKey: companyKey, detectedCompanies: companyHint.matches, evidence: companyHint.sources });
      if (companyHint.detectedCompanyKey && companyHint.detectedCompanyKey !== companyKey) return json(res, 409, { error: `检测到文件地区为 ${companyHint.detectedCompanyName}，与当前选择 ${companyRow(companyKey).company_name} 不一致`, code: 'COMPANY_MISMATCH', selectedCompanyKey: companyKey, selectedCompanyName: companyRow(companyKey).company_name, detectedCompanyKey: companyHint.detectedCompanyKey, detectedCompanyName: companyHint.detectedCompanyName, evidence: companyHint.sources });
      const periodHint = uploadPeriodHint(safeName, reports, period);
      if (periodHint.conflict) return json(res, 409, { error: '文件名或工作表中检测到多个不一致的月份，请核对原始文件后再上传', code: 'PERIOD_HINT_CONFLICT', selectedPeriod: period, detectedPeriods: periodHint.explicitPeriods, detectedMonths: periodHint.monthHints, evidence: periodHint.sources });
      if (periodHint.detectedPeriod && periodHint.detectedPeriod !== period) return json(res, 409, { error: `检测到文件期间为 ${periodHint.detectedPeriod}，与当前选定期间 ${period} 不一致`, code: 'PERIOD_MISMATCH', selectedPeriod: period, detectedPeriod: periodHint.detectedPeriod, evidence: periodHint.sources });
      const periodExcludedReports = reports.periodExcludedReports || [];
      const recognizedTypes = Object.keys(reports).filter(type => reportTypeRow(type)); const selectedTypes = recognizedTypes.length > 1 || !reportType ? recognizedTypes : recognizedTypes.filter(type => type === reportType);
      if (!selectedTypes.length && periodExcludedReports.length) return bad(res, 400, `文件中的报表数据不属于所选期间 ${period}，已阻止生成上传批次`, { code: 'REPORT_PERIOD_EXCLUDED', periodExcludedReports });
      if (!selectedTypes.length) return bad(res, 400, reportType ? '文件中没有找到指定报表工作表' : '文件中没有找到可识别的报表工作表');
      if (selectedTypes.some(type => groupOnlyReportTypes.has(type)) && companyKey !== 'group') return json(res, 409, { error: '集团报表只能归属“桉侨集团”，请切换上传公司后重试', code: 'GROUP_COMPANY_REQUIRED', selectedCompanyKey: companyKey, requiredCompanyKey: 'group' });
      if (companyKey === 'group' && selectedTypes.some(type => !groupOnlyReportTypes.has(type))) return json(res, 409, { error: '“桉侨集团”只接收集团合并利润表、营收统计表和每月工资表，请重新选择报表或公司', code: 'GROUP_REPORT_TYPE_REQUIRED' });
      if (reports.consolidated_income_statement?.reconciliationPassed === false) return bad(res, 400, '合并利润表与公司分表加总不一致，请检查源文件公式和保存结果');
      fs.writeFileSync(storagePath, buffer); fs.writeFileSync(rawPath, JSON.stringify(reports, null, 2), 'utf8');
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      const trimmedSheets = Object.values(reports).filter(item => item?.rangeTrimmed).map(item => `${item.sourceSheet}（${item.declaredRange} → ${item.effectiveRange}）`);
      const trimmedNote = trimmedSheets.length ? `；已自动裁剪异常空白范围：${trimmedSheets.join('、')}` : '';
      const insertUpload = db.prepare('INSERT INTO upload_batches(upload_key, employee_key, company_key, period, report_type, file_name, file_type, storage_path, raw_path, content_hash, status, validation_message, created_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const createdUploads = [];
      for (const type of selectedTypes) {
        const uploadKey = `${bundleKey}-${type}`;
        insertUpload.run(uploadKey, employee.employee_key, companyKey, period, type, fileName, fileType, storagePath, rawPath, hash, 'parsed', `已从汇总文件识别 ${selectedTypes.length} 张报表工作表${reports[type]?.sourceSheet ? `：${reports[type].sourceSheet}` : ''}${trimmedNote}`, now(), notes || (selectedTypes.length > 1 ? '汇总财务报表自动拆分批次' : ''));
        createNormalizedSnapshot({ upload_key: uploadKey, company_key: companyKey, period, report_type: type, file_name: fileName }, reports);
        db.prepare("UPDATE upload_batches SET status = 'validated' WHERE upload_key = ?").run(uploadKey); log(employee.employee_key, 'upload_report', uploadKey, `${companyKey}/${period}/${type}/${fileName}`, { moduleKey: 'uploads', companyKey, period });
        createdUploads.push({ uploadKey, reportType: type, status: 'validated' });
      }
      return json(res, 201, { uploadKey: createdUploads[0].uploadKey, uploadKeys: createdUploads.map(item => item.uploadKey), status: 'validated', uploads: createdUploads, trimmedSheets, periodExcludedReports, sheets: Object.entries(reports).map(([key, value]) => ({ reportType: key, sourceSheet: value.sourceSheet, rows: value.maxRow, columns: value.maxCol, hidden: Boolean(value.hidden), declaredRange: value.declaredRange || '', effectiveRange: value.effectiveRange || '', trimmed: Boolean(value.rangeTrimmed) })) });
    }
    if (url.pathname === '/api/uploads/bulk-publish' && req.method === 'POST') {
      const employee = requireImport(req, res, 'publish'); if (!employee) return;
      const body = await parseBody(req);
      const uploadKeys = [...new Set((Array.isArray(body.uploadKeys) ? body.uploadKeys : []).map(value => String(value || '').trim()).filter(Boolean))];
      if (!uploadKeys.length || uploadKeys.length > 100) return bad(res, 400, '请选择 1 至 100 条已校验记录');
      const placeholders = uploadKeys.map(() => '?').join(',');
      const uploads = db.prepare(`SELECT * FROM upload_batches WHERE upload_key IN (${placeholders})`).all(...uploadKeys);
      if (uploads.length !== uploadKeys.length) return bad(res, 404, '部分上传记录不存在，请刷新后重试');
      if (uploads.some(item => item.status !== 'validated')) return bad(res, 409, '批量发布仅支持已校验且尚未发布的记录');
      const profile = permissionProfileFor(employee.employee_key);
      if (uploads.some(item => !profileScopeAllows(profile, item.company_key, item.period))) return bad(res, 403, '部分记录超出当前员工的公司或期间权限范围');
      const targets = uploads.map(item => `${item.company_key}/${item.period}/${item.report_type}`);
      if (new Set(targets).size !== targets.length) return bad(res, 409, '同一公司、期间和报表类型只能选择一个待发布版本');
      const prepared = [];
      for (const upload of uploads) {
        let sourceReports = {}; try { if (upload.raw_path && fs.existsSync(upload.raw_path)) sourceReports = JSON.parse(fs.readFileSync(upload.raw_path, 'utf8')); } catch {}
        const companyHint = uploadCompanyHint(upload.file_name, sourceReports);
        if (companyHint.conflict) return json(res, 409, { error: `批量发布已拦截：${upload.file_name} 中检测到多个公司地区`, code: 'COMPANY_HINT_CONFLICT', uploadKey: upload.upload_key, detectedCompanies: companyHint.matches });
        if (companyHint.detectedCompanyKey && companyHint.detectedCompanyKey !== upload.company_key) return json(res, 409, { error: `批量发布已拦截：${upload.file_name} 的文件地区为 ${companyHint.detectedCompanyName}，上传记录却选择了 ${companyRow(upload.company_key).company_name}`, code: 'COMPANY_MISMATCH', uploadKey: upload.upload_key, selectedCompanyKey: upload.company_key, detectedCompanyKey: companyHint.detectedCompanyKey });
        const periodHint = uploadPeriodHint(upload.file_name, sourceReports, upload.period);
        if (periodHint.conflict) return json(res, 409, { error: `批量发布已拦截：${upload.file_name} 中检测到多个不一致期间`, code: 'PERIOD_HINT_CONFLICT', uploadKey: upload.upload_key, detectedPeriods: periodHint.explicitPeriods, detectedMonths: periodHint.monthHints });
        if (periodHint.detectedPeriod && periodHint.detectedPeriod !== upload.period) return json(res, 409, { error: `批量发布已拦截：${upload.file_name} 的文件期间为 ${periodHint.detectedPeriod}，上传记录却选择了 ${upload.period}`, code: 'PERIOD_MISMATCH', uploadKey: upload.upload_key, selectedPeriod: upload.period, detectedPeriod: periodHint.detectedPeriod });
        const snapshot = db.prepare('SELECT * FROM report_snapshots WHERE snapshot_key = ?').get(`${upload.company_key}-${upload.period}-${upload.report_type}-upload-${upload.upload_key}`);
        if (!snapshot) return bad(res, 409, `${upload.file_name} 尚未生成可发布版本`);
        prepared.push({ upload, snapshot });
      }
      db.transaction(items => {
        const supersedeUploads = db.prepare("UPDATE upload_batches SET status = 'superseded' WHERE company_key = ? AND period = ? AND report_type = ? AND status = 'published'");
        const supersedeSnapshots = db.prepare("UPDATE report_snapshots SET status = 'superseded' WHERE company_key = ? AND period = ? AND report_type = ? AND status = 'published'");
        const publishSnapshot = db.prepare("UPDATE report_snapshots SET status = 'published' WHERE snapshot_key = ?");
        const publishUpload = db.prepare("UPDATE upload_batches SET status = 'published', published_at = ? WHERE upload_key = ?");
        const publishedAt = now();
        for (const { upload, snapshot } of items) {
          supersedeUploads.run(upload.company_key, upload.period, upload.report_type);
          supersedeSnapshots.run(upload.company_key, upload.period, upload.report_type);
          publishSnapshot.run(snapshot.snapshot_key);
          publishUpload.run(publishedAt, upload.upload_key);
        }
      })(prepared);
      for (const { upload } of prepared) log(employee.employee_key, 'publish_upload', upload.upload_key, `${upload.company_key}/${upload.period}/${upload.report_type}/bulk`, { moduleKey: 'uploads', companyKey: upload.company_key, period: upload.period });
      return json(res, 200, { ok: true, publishedCount: prepared.length, publishedKeys: prepared.map(item => item.upload.upload_key) });
    }
    if (url.pathname === '/api/uploads/bulk-delete' && req.method === 'POST') {
      const employee = requireImport(req, res, 'upload'); if (!employee) return;
      const body = await parseBody(req);
      const uploadKeys = [...new Set((Array.isArray(body.uploadKeys) ? body.uploadKeys : []).map(value => String(value || '').trim()).filter(Boolean))];
      if (!uploadKeys.length || uploadKeys.length > 100) return bad(res, 400, '请选择 1 至 100 条可处理记录');
      const placeholders = uploadKeys.map(() => '?').join(',');
      const uploads = db.prepare(`SELECT * FROM upload_batches WHERE upload_key IN (${placeholders})`).all(...uploadKeys);
      if (uploads.length !== uploadKeys.length) return bad(res, 404, '部分上传记录不存在，请刷新后重试');
      if (uploads.some(item => !deletableUploadStatuses.has(item.status))) return bad(res, 409, '历史版本不能直接删除；当前发布可撤回后删除');
      if (uploads.some(item => !canDeleteUpload(employee.employee_key, item))) return bad(res, 403, '只能处理权限范围内的本人未发布记录；撤回当前发布还需要发布权限');
      for (const item of uploads.filter(row => row.status === 'published')) {
        const snapshotKey = `${item.company_key}-${item.period}-${item.report_type}-upload-${item.upload_key}`;
        if (!db.prepare("SELECT 1 FROM report_snapshots WHERE snapshot_key = ? AND status = 'published'").get(snapshotKey)) return bad(res, 409, '当前发布记录与版本状态不一致，请刷新后重试');
      }
      const deleteRows = db.transaction(items => {
        const removeLines = db.prepare('DELETE FROM report_lines WHERE snapshot_key = ?');
        const removeDetails = db.prepare('DELETE FROM report_details WHERE snapshot_key = ?');
        const removeSnapshot = db.prepare('DELETE FROM report_snapshots WHERE snapshot_key = ?');
        const removeUpload = db.prepare('DELETE FROM upload_batches WHERE upload_key = ?');
        const previousSnapshot = db.prepare("SELECT snapshot_key AS snapshotKey, version FROM report_snapshots WHERE company_key = ? AND period = ? AND report_type = ? AND status = 'superseded' AND snapshot_key LIKE '%-upload-%' ORDER BY version DESC LIMIT 1");
        const publishSnapshot = db.prepare("UPDATE report_snapshots SET status = 'published' WHERE snapshot_key = ?");
        const publishUpload = db.prepare("UPDATE upload_batches SET status = 'published', published_at = ? WHERE upload_key = ? AND status = 'superseded'");
        let withdrawnCount = 0; let restoredCount = 0;
        for (const item of items) {
          const snapshotKey = `${item.company_key}-${item.period}-${item.report_type}-upload-${item.upload_key}`;
          removeLines.run(snapshotKey); removeDetails.run(snapshotKey); removeSnapshot.run(snapshotKey); removeUpload.run(item.upload_key);
          if (item.status === 'published') {
            withdrawnCount += 1;
            const previous = previousSnapshot.get(item.company_key, item.period, item.report_type);
            if (previous) {
              const previousUploadKey = previous.snapshotKey.slice(previous.snapshotKey.indexOf('-upload-') + '-upload-'.length);
              publishSnapshot.run(previous.snapshotKey); publishUpload.run(now(), previousUploadKey); restoredCount += 1;
              log(employee.employee_key, 'restore_previous_upload', previousUploadKey, `${item.company_key}/${item.period}/${item.report_type}/v${previous.version}`, { moduleKey: 'uploads', companyKey: item.company_key, period: item.period });
            }
            log(employee.employee_key, 'withdraw_published_upload', item.upload_key, `${item.company_key}/${item.period}/${item.report_type}/${item.file_name}`, { moduleKey: 'uploads', companyKey: item.company_key, period: item.period });
          } else log(employee.employee_key, 'delete_unpublished_upload', item.upload_key, `${item.company_key}/${item.period}/${item.report_type}/${item.file_name}`, { moduleKey: 'uploads', companyKey: item.company_key, period: item.period });
        }
        return { withdrawnCount, restoredCount };
      });
      const deletion = deleteRows(uploads);
      const referencedPath = db.prepare('SELECT 1 FROM upload_batches WHERE storage_path = ? OR raw_path = ? LIMIT 1');
      const uploadsRoot = `${path.resolve(uploadsDir)}${path.sep}`;
      for (const file of [...new Set(uploads.flatMap(item => [item.storage_path, item.raw_path]).filter(Boolean))]) {
        const resolved = path.resolve(file);
        if (!resolved.startsWith(uploadsRoot) || referencedPath.get(file, file)) continue;
        try { if (fs.existsSync(resolved)) fs.unlinkSync(resolved); } catch {}
      }
      return json(res, 200, { ok: true, deletedCount: uploads.length, withdrawnCount: deletion.withdrawnCount, restoredCount: deletion.restoredCount, noDataCount: deletion.withdrawnCount - deletion.restoredCount, deletedKeys: uploadKeys });
    }
    const uploadActionMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/(validate|publish)$/);
    if (uploadActionMatch && req.method === 'POST') {
      const [, uploadKey, action] = uploadActionMatch; const employee = requireImport(req, res, action); if (!employee) return;
      const upload = db.prepare('SELECT * FROM upload_batches WHERE upload_key = ?').get(uploadKey); if (!upload) return bad(res, 404, '上传批次不存在');
      if (!importScopeAllows(employee, res, upload.company_key, upload.period)) return;
      if (action === 'validate') { db.prepare("UPDATE upload_batches SET status = 'validated', validation_message = '校验通过' WHERE upload_key = ? AND status IN ('parsed', 'validated')").run(uploadKey); log(employee.employee_key, 'validate_upload', uploadKey, '校验通过', { moduleKey: 'uploads', companyKey: upload.company_key, period: upload.period }); return json(res, 200, { ok: true, status: 'validated' }); }
      let sourceReports = {}; try { if (upload.raw_path && fs.existsSync(upload.raw_path)) sourceReports = JSON.parse(fs.readFileSync(upload.raw_path, 'utf8')); } catch {}
      const publishCompanyHint = uploadCompanyHint(upload.file_name, sourceReports);
      if (publishCompanyHint.conflict) return json(res, 409, { error: '发布已拦截：文件中检测到多个公司地区，请核对原始文件', code: 'COMPANY_HINT_CONFLICT', detectedCompanies: publishCompanyHint.matches });
      if (publishCompanyHint.detectedCompanyKey && publishCompanyHint.detectedCompanyKey !== upload.company_key) return json(res, 409, { error: `发布已拦截：文件地区为 ${publishCompanyHint.detectedCompanyName}，上传记录却选择了 ${companyRow(upload.company_key).company_name}；请删除后按正确地区重新上传`, code: 'COMPANY_MISMATCH', selectedCompanyKey: upload.company_key, selectedCompanyName: companyRow(upload.company_key).company_name, detectedCompanyKey: publishCompanyHint.detectedCompanyKey, detectedCompanyName: publishCompanyHint.detectedCompanyName });
      const publishPeriodHint = uploadPeriodHint(upload.file_name, sourceReports, upload.period);
      if (publishPeriodHint.conflict) return json(res, 409, { error: '发布已拦截：文件中检测到多个不一致期间，请核对原始文件', code: 'PERIOD_HINT_CONFLICT', detectedPeriods: publishPeriodHint.explicitPeriods, detectedMonths: publishPeriodHint.monthHints });
      if (publishPeriodHint.detectedPeriod && publishPeriodHint.detectedPeriod !== upload.period) return json(res, 409, { error: `发布已拦截：文件期间为 ${publishPeriodHint.detectedPeriod}，上传记录却选择了 ${upload.period}；请删除后按正确期间重新上传`, code: 'PERIOD_MISMATCH', selectedPeriod: upload.period, detectedPeriod: publishPeriodHint.detectedPeriod });
      const snapshot = db.prepare("SELECT * FROM report_snapshots WHERE snapshot_key LIKE ? ORDER BY version DESC LIMIT 1").get(`%-upload-${uploadKey}`); if (!snapshot) return bad(res, 409, '该上传批次尚未生成可发布版本');
      db.prepare("UPDATE upload_batches SET status = 'superseded' WHERE company_key = ? AND period = ? AND report_type = ? AND status = 'published'").run(upload.company_key, upload.period, upload.report_type);
      db.prepare("UPDATE report_snapshots SET status = 'superseded' WHERE company_key = ? AND period = ? AND report_type = ? AND status = 'published'").run(upload.company_key, upload.period, upload.report_type);
      db.prepare("UPDATE report_snapshots SET status = 'published' WHERE snapshot_key = ?").run(snapshot.snapshot_key);
      db.prepare("UPDATE upload_batches SET status = 'published', published_at = ? WHERE upload_key = ?").run(now(), uploadKey); log(employee.employee_key, 'publish_upload', uploadKey, `${upload.company_key}/${upload.period}/${upload.report_type}`, { moduleKey: 'uploads', companyKey: upload.company_key, period: upload.period }); return json(res, 200, { ok: true, status: 'published', version: snapshot.version });
    }
    if (url.pathname === '/api/reports/balance_sheet/analysis' && req.method === 'GET') {
      const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06';
      if (!companyRow(companyKey)) return bad(res, 404, '公司不存在');
      const employee = requireReport(req, res, 'balance_sheet', 'summary', 'view', companyKey, period); if (!employee) return;
      const source = rawReportFor('balance_sheet', companyKey, period);
      const snapshot = source.meta.uploadKey ? db.prepare("SELECT version, status FROM report_snapshots WHERE company_key = ? AND period = ? AND report_type = 'balance_sheet' AND snapshot_key LIKE ? ORDER BY version DESC LIMIT 1").get(companyKey, period, `%${source.meta.uploadKey}`) : null;
      const analysis = parseAssetLiabilityAnalysis(source.raw);
      log(employee.employee_key, 'view_asset_liability_analysis', 'balance_sheet:analysis', `${companyKey}/${period}`, { moduleKey: 'balance_sheet', companyKey, period });
      return json(res, 200, { ...analysis, company: companyRow(companyKey).company_name, period, meta: { ...source.meta, version: snapshot?.version || null, snapshotStatus: snapshot?.status || source.meta.status } });
    }
    const rawMatch = url.pathname.match(/^\/api\/reports\/([^/]+)\/raw$/);
    if (rawMatch && req.method === 'GET') {
      const reportType = rawMatch[1]; const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06'; if (!reportTypeRow(reportType) || !companyRow(companyKey)) return bad(res, 404, '报表或公司不存在');
      if (sourceOnlyReportTypes.has(reportType)) return bad(res, 403, '该敏感数据源不提供整表浏览或导出');
      const employee = requireReport(req, res, reportType, 'summary', 'view', companyKey, period); if (!employee) return;
      const upload = url.searchParams.get('uploadKey') ? db.prepare('SELECT * FROM upload_batches WHERE upload_key = ? AND company_key = ? AND period = ? AND report_type = ?').get(url.searchParams.get('uploadKey'), companyKey, period, reportType) : db.prepare("SELECT * FROM upload_batches WHERE company_key = ? AND period = ? AND report_type = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1").get(companyKey, period, reportType);
      let raw; let meta;
      if (upload && fs.existsSync(upload.raw_path)) { const all = JSON.parse(fs.readFileSync(upload.raw_path, 'utf8')); raw = all[reportType] || all; meta = { demo: false, uploadKey: upload.upload_key, fileName: upload.file_name, uploadedBy: upload.employee_key, status: upload.status, createdAt: upload.created_at, publishedAt: upload.published_at }; }
      else { const missing = rawReportFor(reportType, companyKey, period); raw = missing.raw; meta = { ...missing.meta, uploadedBy: null }; }
      if (reportType === revenueStatisticsReportType) raw = refreshedRevenueStatisticsRawFor({ raw, meta }, period);
      log(employee.employee_key, 'view_raw_report', `${reportType}:raw`, `${companyKey}/${period}`, { moduleKey: reportType, companyKey, period }); return json(res, 200, { report: reportType, company: companyRow(companyKey).company_name, period, meta, raw });
    }
    if (url.pathname === '/api/analysis/financial-brief' && req.method === 'GET') {
      const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06';
      if (!companyRow(companyKey)) return bad(res, 404, '公司不存在');
      const employee = requireEmployee(req, res); if (!employee) return;
      if (!hasAnalysis(employee.employee_key, financialBriefModuleKey, companyKey, period)) return bad(res, 403, '当前员工没有财务数据简报权限');
      const brief = financialBriefFor(companyKey, period); const secondaryItems = financialBriefItemsFor(companyKey, period); const canManageSecondaryItems = hasPermissionKey(employee.employee_key, financialBriefNotesPermissionKey, companyKey, period);
      log(employee.employee_key, 'view_financial_brief', financialBriefModuleKey, `${companyKey}/${period}`, { moduleKey: financialBriefModuleKey, companyKey, period });
      return json(res, 200, { ...brief, secondaryItems, canManageSecondaryItems });
    }
    if (['/api/analysis/financial-brief/secondary-items', '/api/analysis/financial-brief/notes'].includes(url.pathname) && ['POST', 'PUT', 'DELETE'].includes(req.method)) {
      const employee = requireEmployee(req, res); if (!employee) return;
      const body = await parseBody(req); const itemKey = String(body.itemKey || body.noteKey || '');
      if (req.method === 'POST') {
        const companyKey = String(body.companyKey || ''); const period = String(body.period || ''); const metricKey = String(body.metricKey || ''); const itemName = normalizeFinancialBriefItemName(body.name); const itemAmount = normalizeFinancialBriefItemAmount(body.amount);
        if (!companyRow(companyKey)) return bad(res, 404, '公司不存在');
        if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(period)) return bad(res, 400, '会计期间格式无效');
        if (!financialBriefMetricKeys.has(metricKey)) return bad(res, 400, metricKey === 'comprehensiveRevenueProfit' ? '营收综合利润不支持二级项目' : '简报项目无效');
        if (!itemName || itemName.length > 80) return bad(res, 400, '二级项目名称应为 1 至 80 个字符');
        if (itemAmount === null) return bad(res, 400, '二级项目金额格式无效');
        if (!hasAnalysis(employee.employee_key, financialBriefModuleKey, companyKey, period) || !hasPermissionKey(employee.employee_key, financialBriefNotesPermissionKey, companyKey, period)) return bad(res, 403, '当前员工没有简报二级项目编辑权限');
        const createdAt = now(); const createdKey = `fbn-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        db.prepare('INSERT INTO financial_brief_notes(note_key, company_key, period, metric_key, note_text, item_name, item_amount, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(createdKey, companyKey, period, metricKey, itemName, itemName, itemAmount, employee.employee_key, createdAt, createdAt);
        log(employee.employee_key, 'create_financial_brief_item', createdKey, `${metricKey}:${itemName}:${itemAmount}`, { moduleKey: financialBriefModuleKey, companyKey, period });
        return json(res, 201, { ok: true, item: financialBriefItemRow(createdKey) });
      }
      const existing = financialBriefItemRow(itemKey); if (!existing) return bad(res, 404, '简报二级项目不存在');
      if (!hasAnalysis(employee.employee_key, financialBriefModuleKey, existing.companyKey, existing.period) || !hasPermissionKey(employee.employee_key, financialBriefNotesPermissionKey, existing.companyKey, existing.period)) return bad(res, 403, '当前员工没有简报二级项目编辑权限');
      if (req.method === 'PUT') {
        const itemName = normalizeFinancialBriefItemName(body.name); const itemAmount = normalizeFinancialBriefItemAmount(body.amount);
        if (!itemName || itemName.length > 80) return bad(res, 400, '二级项目名称应为 1 至 80 个字符');
        if (itemAmount === null) return bad(res, 400, '二级项目金额格式无效');
        db.prepare('UPDATE financial_brief_notes SET note_text = ?, item_name = ?, item_amount = ?, updated_at = ? WHERE note_key = ?').run(itemName, itemName, itemAmount, now(), itemKey);
        log(employee.employee_key, 'update_financial_brief_item', itemKey, `${itemName}:${itemAmount}`, { moduleKey: financialBriefModuleKey, companyKey: existing.companyKey, period: existing.period });
        return json(res, 200, { ok: true, item: financialBriefItemRow(itemKey) });
      }
      db.prepare('DELETE FROM financial_brief_notes WHERE note_key = ?').run(itemKey);
      log(employee.employee_key, 'delete_financial_brief_item', itemKey, `${existing.metricKey}:${existing.name}:${existing.amount}`, { moduleKey: financialBriefModuleKey, companyKey: existing.companyKey, period: existing.period });
      return json(res, 200, { ok: true, removed: 1 });
    }
    if (url.pathname === '/api/analysis/group-profit-trends' && req.method === 'GET') {
      const companyKey = url.searchParams.get('company') || 'group'; const period = url.searchParams.get('period') || '2026-07'; const year = url.searchParams.get('year') || period.slice(0, 4);
      if (companyKey !== 'group') return bad(res, 400, '集团合并利润趋势图仅适用于桉侨集团');
      const employee = requireEmployee(req, res); if (!employee) return;
      if (!hasAnalysis(employee.employee_key, 'group_profit_analysis', companyKey, period) || !hasReport(employee.employee_key, 'consolidated_income_statement', 'summary', 'view', companyKey, period)) { bad(res, 403, '当前员工没有集团合并利润趋势图权限'); return; }
      const analysis = groupProfitAnalysisFor(period, year); log(employee.employee_key, 'view_group_profit_analysis', 'group_profit_analysis', `${companyKey}/${period}`, { moduleKey: 'group_profit_analysis', companyKey, period });
      return json(res, 200, { company: companyRow(companyKey).company_name, period, ...analysis });
    }
    if (url.pathname === '/api/analysis/consultant-roi' && req.method === 'GET') {
      const companyKey = url.searchParams.get('company') || 'group'; const period = url.searchParams.get('period') || '2026-07';
      if (companyKey !== 'group') return bad(res, 400, '顾问投入产出比仅适用于桉侨集团');
      const employee = requireEmployee(req, res); if (!employee) return;
      if (!hasAnalysis(employee.employee_key, consultantRoiModuleKey, companyKey, period)) return bad(res, 403, '当前员工没有顾问投入产出比权限');
      const analysis = consultantRoiAnalysisFor(employee.employee_key, period); log(employee.employee_key, 'view_consultant_roi_analysis', consultantRoiModuleKey, `${companyKey}/${period}`, { moduleKey: consultantRoiModuleKey, companyKey, period });
      return json(res, 200, analysis);
    }
    if (url.pathname.startsWith('/api/analysis/intercompany-reconciliation') && req.method === 'GET') {
      const companyKey = url.searchParams.get('company') || 'group'; const period = url.searchParams.get('period') || '2026-07';
      if (companyKey !== 'group') return bad(res, 400, '各公司往来校验仅适用于桉侨集团');
      if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(period)) return bad(res, 400, '会计期间格式无效');
      const employee = requireEmployee(req, res); if (!employee) return;
      if (!hasPermissionKey(employee.employee_key, intercompanyViewPermissionKey, companyKey, period)) return bad(res, 403, '当前员工没有各公司往来校验权限');
      const analysis = intercompanyAnalysisFor(employee.employee_key, period);
      if (url.pathname === '/api/analysis/intercompany-reconciliation/unmapped') {
        log(employee.employee_key, 'view_intercompany_unmapped', intercompanyModuleKey, `${companyKey}/${period}`, { moduleKey: intercompanyModuleKey, companyKey, period });
        return json(res, 200, { company: analysis.company, period, tolerance: analysis.tolerance, rows: analysis.unmapped });
      }
      if (url.pathname === '/api/analysis/intercompany-reconciliation/pair') {
        const companyA = String(url.searchParams.get('companyA') || ''); const companyB = String(url.searchParams.get('companyB') || '');
        const pair = analysis.pairs.find(item => new Set([item.companyA.key, item.companyB.key]).size === 2 && [item.companyA.key, item.companyB.key].includes(companyA) && [item.companyA.key, item.companyB.key].includes(companyB));
        if (!pair || companyA === companyB) return bad(res, 404, '往来组合不存在或不在当前员工数据范围内');
        const canViewJournal = hasPermissionKey(employee.employee_key, intercompanyDetailPermissionKey, companyKey, period)
          && hasReport(employee.employee_key, 'journal', 'detail', 'view', pair.companyA.key, period)
          && hasReport(employee.employee_key, 'journal', 'detail', 'view', pair.companyB.key, period);
        const journals = canViewJournal ? {
          [pair.companyA.key]: intercompanyJournalRowsFor(pair.companyA.key, period, pair.sideA.rows.map(row => row.code)),
          [pair.companyB.key]: intercompanyJournalRowsFor(pair.companyB.key, period, pair.sideB.rows.map(row => row.code))
        } : {};
        log(employee.employee_key, 'view_intercompany_pair', pair.pairKey, `${period};journal=${canViewJournal}`, { moduleKey: intercompanyModuleKey, companyKey, period });
        return json(res, 200, { company: analysis.company, period, tolerance: analysis.tolerance, pair, canViewJournal, journals });
      }
      if (url.pathname !== '/api/analysis/intercompany-reconciliation') return bad(res, 404, '接口不存在');
      log(employee.employee_key, 'view_intercompany_reconciliation', intercompanyModuleKey, `${companyKey}/${period}`, { moduleKey: intercompanyModuleKey, companyKey, period });
      return json(res, 200, analysis);
    }
    if (url.pathname === '/api/analysis/cash-flow' && req.method === 'GET') {
      const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06'; const year = url.searchParams.get('year') || period.slice(0, 4);
      if (!companyRow(companyKey)) return bad(res, 404, '公司不存在');
      const employee = requireEmployee(req, res); if (!employee) return;
      if (!hasAnalysis(employee.employee_key, 'cash_analysis', companyKey, period)) { bad(res, 403, '当前员工没有资产净额分析权限'); return; }
      const analysis = cashFlowAnalysisFor(companyKey, period, year); log(employee.employee_key, 'view_cash_flow_analysis', 'cash_flow_analysis', `${companyKey}/${period}`, { moduleKey: 'cash_analysis', companyKey, period });
      const access = analysisBlockAccessFor(employee.employee_key, companyKey, period).cash_analysis;
      return json(res, 200, {
        company: companyRow(companyKey).company_name, period, ...analysis,
        internalPositions: access.net_positions ? analysis.internalPositions : [],
        cashAccounts: access.cash_accounts ? analysis.cashAccounts : [],
        otherCurrentItems: access.other_liquidity ? analysis.otherCurrentItems : [],
        monthlyTrend: access.core_liquidity_trend ? analysis.monthlyTrend : []
      });
    }
    if (url.pathname === '/api/analysis/main-business' && req.method === 'GET') {
      const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06'; const year = url.searchParams.get('year') || period.slice(0, 4);
      if (!companyRow(companyKey)) return bad(res, 404, '公司不存在');
      const employee = requireEmployee(req, res); if (!employee) return;
      if (!hasAnalysis(employee.employee_key, 'main_business_analysis', companyKey, period)) { bad(res, 403, '当前员工没有主营业务分析权限'); return; }
      const analysis = mainBusinessAnalysisFor(companyKey, period, year); log(employee.employee_key, 'view_main_business_analysis', 'main_business_analysis', `${companyKey}/${period}`, { moduleKey: 'main_business_analysis', companyKey, period });
      const access = analysisBlockAccessFor(employee.employee_key, companyKey, period).main_business_analysis;
      return json(res, 200, { ...analysis, detailRows: access.business_detail ? analysis.detailRows : [], projectRows: access.project_change ? analysis.projectRows : [], monthlyTrend: access.gross_trend ? analysis.monthlyTrend : [] });
    }
    if (url.pathname === '/api/analysis/expenses' && req.method === 'GET') {
      const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06'; const year = url.searchParams.get('year') || period.slice(0, 4);
      if (!companyRow(companyKey)) return bad(res, 404, '公司不存在');
      const employee = requireEmployee(req, res); if (!employee) return;
      if (!hasAnalysis(employee.employee_key, 'expense_analysis', companyKey, period)) { bad(res, 403, '当前员工没有费用分析权限'); return; }
      const analysis = expenseAnalysisFor(companyKey, period, year); log(employee.employee_key, 'view_expense_analysis', 'expense_analysis', `${companyKey}/${period}`, { moduleKey: 'expense_analysis', companyKey, period });
      const access = analysisBlockAccessFor(employee.employee_key, companyKey, period).expense_analysis;
      const expenseSectionForAccess = (section, tableAllowed, shareAllowed, trendAllowed) => ({
        ...section,
        rows: tableAllowed ? section.rows : shareAllowed ? section.rows.map(row => ({ name: row.name, current: row.current, share: row.share })) : [],
        monthly: trendAllowed ? section.monthly : []
      });
      const financeRows = access.finance_table ? analysis.finance.rows : (access.finance_share || access.finance_methods) ? analysis.finance.rows.map(row => ({ method: row.method, current: row.current, share: row.share })) : [];
      return json(res, 200, {
        ...analysis,
        selling: expenseSectionForAccess(analysis.selling, access.selling_table, access.selling_share, access.selling_trend),
        administration: expenseSectionForAccess(analysis.administration, access.admin_table, access.admin_share, access.admin_trend),
        finance: { ...analysis.finance, rows: financeRows, feeTotal: access.finance_table ? analysis.finance.feeTotal : 0 }
      });
    }
    const reportMatch = url.pathname.match(/^\/api\/reports\/([^/]+)\/(summary|detail|versions|export)$/);
    if (reportMatch) {
      const [, reportType, operation] = reportMatch; const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06'; const lineCode = url.searchParams.get('line') || ''; const search = url.searchParams.get('search') || ''; const accountCodes = [...new Set(String(url.searchParams.get('accountCodes') || '').split(',').map(value => value.trim()).filter(Boolean))].slice(0, 20);
      if (!reportTypeRow(reportType) || !companyRow(companyKey)) return bad(res, 404, '报表或公司不存在');
      if (sourceOnlyReportTypes.has(reportType)) return bad(res, 403, '该敏感数据源不提供整表浏览或导出');
      const level = operation === 'summary' || operation === 'versions' ? 'summary' : operation === 'export' ? (url.searchParams.get('level') || 'detail') : 'detail'; const action = operation === 'export' ? 'export' : 'view'; const employee = requireReport(req, res, reportType, level, action, companyKey, period); if (!employee) return;
      if (operation === 'versions') return json(res, 200, { versions: db.prepare("SELECT version, status, source_name AS source, notes, created_at AS createdAt FROM report_snapshots WHERE company_key = ? AND period = ? AND report_type = ? AND snapshot_key LIKE '%-upload-%' ORDER BY version DESC").all(companyKey, period, reportType) });
      const snapshot = snapshotFor(companyKey, period, reportType, url.searchParams.get('version')); if (!snapshot) {
        if (operation === 'detail' && search) { const preference = detailPreferenceFor(employee.employee_key); const sourceDetail = sourceDetailFor(reportType, companyKey, period, search, employee.employee_key, preference.showFullEntry, accountCodes); return json(res, 200, { report: reportType, company: companyRow(companyKey).company_name, period, line: lineCode || null, search, accountCodes, snapshot: null, rows: [], ...sourceDetail, accountVisibility: accountVisibilityFor(employee.employee_key), showDirection: preference.showDirection, showFullEntry: preference.showFullEntry }); }
        return bad(res, 404, '该期间没有已保存的报表版本');
      }
      log(employee.employee_key, action === 'export' ? 'export_report' : 'view_report', `${reportType}:${level}`, `${companyKey}/${period}/v${snapshot.version}`, { moduleKey: reportType, companyKey, period });
      if (operation === 'export') {
        const rows = level === 'summary' ? db.prepare('SELECT line_code, line_name, category, current_amount, prior_amount FROM report_lines WHERE snapshot_key = ? ORDER BY sort_order').all(snapshot.snapshot_key) : detailRowsFor(snapshot.snapshot_key, reportType, lineCode, search);
        const headers = Object.keys(rows[0] || { message: '无数据' }); const csv = [headers.join(','), ...rows.map(row => headers.map(key => `"${String(row[key] ?? '').replaceAll('"', '""')}"`).join(','))].join('\n'); return text(res, 200, csv, 'text/csv; charset=utf-8');
      }
      const lines = reportLinesForSnapshot(snapshot, reportType);
      if (operation === 'detail') { const visibility = accountVisibilityFor(employee.employee_key); const preference = detailPreferenceFor(employee.employee_key); const detailRows = detailRowsFor(snapshot.snapshot_key, reportType, lineCode, search, preference.showFullEntry).map(row => ({ ...row, account: accountNameForVisibility(row.account, visibility) })); const sourceDetail = search && !detailRows.length ? sourceDetailFor(reportType, companyKey, period, search, employee.employee_key, preference.showFullEntry, accountCodes) : { detailKind: 'journal', rawRows: [], workpaperRows: [] }; return json(res, 200, { report: reportType, company: companyRow(companyKey).company_name, period, line: lineCode || null, search: search || null, accountCodes, snapshot: { version: snapshot.version, status: snapshot.status, source: snapshot.source_name, notes: snapshot.notes }, rows: detailRows, ...sourceDetail, accountVisibility: visibility, showDirection: preference.showDirection, showFullEntry: preference.showFullEntry }); }
      const trend = db.prepare("SELECT * FROM report_snapshots WHERE company_key = ? AND report_type = ? AND status = 'published' AND snapshot_key LIKE '%-upload-%' ORDER BY period").all(companyKey, reportType)
        .filter(row => hasReport(employee.employee_key, reportType, 'summary', 'view', companyKey, row.period))
        .map(row => ({ period: row.period, version: row.version, lines: reportLinesForSnapshot(row, reportType) }));
      return json(res, 200, { report: reportType, company: companyRow(companyKey).company_name, period, snapshot: { version: snapshot.version, status: snapshot.status, source: snapshot.source_name, notes: snapshot.notes }, lines, trend });
    }
    if (url.pathname === '/api/admin/company-order' && req.method === 'POST') {
      const employee = requireEmployee(req, res); const profile = employee ? permissionProfileFor(employee.employee_key) : null;
      if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage') || !profile.companyKeys.includes('*')) { if (employee) bad(res, 403, '只有拥有全部公司范围的管理员可以调整公司顺序'); return; }
      const body = await parseBody(req); const requested = Array.isArray(body.order) ? body.order.map(String) : [];
      const current = companyOrderFor().map(row => row.key); const expected = new Set(current);
      if (requested.length !== current.length || new Set(requested).size !== current.length || requested.some(key => !expected.has(key))) return bad(res, 400, '公司顺序无效');
      db.transaction(() => requested.forEach((key, index) => db.prepare('UPDATE company_display_order SET sort_order = ? WHERE company_key = ?').run((index + 1) * 10, key)))();
      log(employee.employee_key, 'set_company_order', 'companies', requested.join(','));
      return json(res, 200, { ok: true, order: companyOrderFor().map(row => row.key) });
    }
    if (url.pathname === '/api/admin/module-order' && req.method === 'POST') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '没有权限管理看板顺序'); return; }
      const body = await parseBody(req); const requested = Array.isArray(body.order) ? body.order.map(String) : [];
      const current = moduleOrderFor().map(row => row.key); const expected = new Set(current);
      if (requested.length !== current.length || new Set(requested).size !== current.length || requested.some(key => !expected.has(key))) return bad(res, 400, '看板模块顺序无效');
      const update = db.transaction(() => requested.forEach((key, index) => db.prepare('UPDATE dashboard_module_order SET sort_order = ? WHERE module_key = ?').run((index + 1) * 10, key)));
      update(); log(employee.employee_key, 'set_module_order', 'dashboard', requested.join(','));
      return json(res, 200, { ok: true, moduleOrder: moduleOrderFor() });
    }
    if (url.pathname === '/api/admin/analysis-block-order' && req.method === 'POST') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '只有管理员可以调整分析板块顺序'); return; }
      const body = await parseBody(req); const pageKey = String(body.pageKey || ''); const requested = Array.isArray(body.order) ? body.order.map(String) : []; const current = analysisBlockDefaults[pageKey] || []; const expected = new Set(current);
      if (!current.length || requested.length !== current.length || new Set(requested).size !== current.length || requested.some(key => !expected.has(key))) return bad(res, 400, '分析页面或板块顺序无效');
      const update = db.transaction(() => requested.forEach((key, index) => db.prepare('UPDATE analysis_block_order SET sort_order = ? WHERE page_key = ? AND block_key = ?').run((index + 1) * 10, pageKey, key)));
      update(); log(employee.employee_key, 'set_analysis_block_order', pageKey, requested.join(','));
      return json(res, 200, { ok: true, pageKey, order: analysisBlockOrderFor(pageKey) });
    }
    if (url.pathname === '/api/admin/report-data/summary' && req.method === 'GET') {
      const employee = requireReportDataAdmin(req, res); if (!employee) return;
      const companyKey = url.searchParams.get('company') || ''; const period = url.searchParams.get('period') || '';
      const clauses = []; const args = [];
      if (companyKey) { clauses.push('company_key = ?'); args.push(companyKey); }
      if (period) { clauses.push('period = ?'); args.push(period); }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const statusRows = db.prepare(`SELECT status, COUNT(*) AS count FROM upload_batches${where} GROUP BY status ORDER BY status`).all(...args);
      const total = db.prepare(`SELECT COUNT(*) AS count FROM upload_batches${where}`).get(...args).count;
      const published = db.prepare(`SELECT COUNT(*) AS count FROM upload_batches${where}${where ? ' AND' : ' WHERE'} status = 'published'`).get(...args).count;
      const latest = db.prepare(`SELECT COUNT(*) AS count FROM report_snapshots WHERE status = 'published'${companyKey ? ' AND company_key = ?' : ''}${period ? ' AND period = ?' : ''}`).get(...[...(companyKey ? [companyKey] : []), ...(period ? [period] : [])]).count;
      return json(res, 200, { total, published, currentVersions: latest, statuses: statusRows });
    }
    if (url.pathname === '/api/admin/report-data/batches' && req.method === 'GET') {
      const employee = requireReportDataAdmin(req, res); if (!employee) return;
      const companyKey = url.searchParams.get('company') || ''; const period = url.searchParams.get('period') || ''; const reportType = url.searchParams.get('reportType') || ''; const status = url.searchParams.get('status') || ''; const search = url.searchParams.get('search') || '';
      const page = Math.max(1, Number(url.searchParams.get('page') || 1)); const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') || 20)));
      const clauses = ['1 = 1']; const args = [];
      if (companyKey) { clauses.push('u.company_key = ?'); args.push(companyKey); }
      if (period) { clauses.push('u.period = ?'); args.push(period); }
      if (reportType) { clauses.push('u.report_type = ?'); args.push(reportType); }
      if (status) { clauses.push('u.status = ?'); args.push(status); }
      if (search) { clauses.push('(u.file_name LIKE ? OR u.upload_key LIKE ? OR u.content_hash LIKE ?)'); args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
      const where = clauses.join(' AND ');
      const total = db.prepare(`SELECT COUNT(*) AS count FROM upload_batches u WHERE ${where}`).get(...args).count;
      const items = db.prepare(`SELECT u.upload_key AS uploadKey, u.company_key AS companyKey, c.company_name AS companyName, u.period, u.report_type AS reportType, rt.report_name AS reportName, u.file_name AS fileName, u.file_type AS fileType, u.content_hash AS contentHash, u.status, u.validation_message AS validationMessage, u.created_at AS createdAt, u.published_at AS publishedAt, u.notes, u.employee_key AS employeeKey, e.display_name AS employeeName, (SELECT MAX(rs.version) FROM report_snapshots rs WHERE rs.company_key = u.company_key AND rs.period = u.period AND rs.report_type = u.report_type) AS latestVersion, (SELECT rs.version FROM report_snapshots rs WHERE rs.company_key = u.company_key AND rs.period = u.period AND rs.report_type = u.report_type AND rs.status = 'published' ORDER BY rs.version DESC LIMIT 1) AS publishedVersion FROM upload_batches u JOIN companies c ON c.company_key = u.company_key JOIN report_types rt ON rt.report_type = u.report_type JOIN employees e ON e.employee_key = u.employee_key WHERE ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize).map(item => ({ ...item, rawAvailable: Boolean(db.prepare('SELECT raw_path FROM upload_batches WHERE upload_key = ? AND raw_path IS NOT NULL').get(item.uploadKey)) }));
      return json(res, 200, { items, page, pageSize, total });
    }
    if (url.pathname === '/api/admin/directory-sync' && req.method === 'POST') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '没有权限同步通讯录'); return; }
      const accessToken = parseBearerToken(req.headers.authorization);
      if (!accessToken) return json(res, 401, { error: '缺少小Q登录凭证', loginUrl: platformLoginUrl });
      try {
        const rolePayload = await platformJson('/data-dist/my-roles', accessToken); const platformRoles = Array.isArray(rolePayload) ? rolePayload : rolePayload?.roles;
        if (!Array.isArray(platformRoles) || !platformRoles.includes('admin')) return bad(res, 403, '只有小Q管理员组可以同步成员目录');
        const groups = await platformJson('/data-dist/user-groups', accessToken); const sync = syncPlatformDirectory(groups, employee.employee_key);
        return json(res, 200, { ok: true, sync });
      } catch (error) {
        if (error instanceof PlatformApiError && error.status === 401) return json(res, 401, { error: error.message, loginUrl: platformLoginUrl });
        return json(res, 502, { error: '小Q成员目录同步失败', sync: directorySyncState() });
      }
    }
    if (url.pathname === '/api/admin/directory-employees' && req.method === 'GET') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '没有权限查看通讯录'); return; }
      const sync = directorySyncState();
      const search = String(url.searchParams.get('search') || '').trim(); const like = `%${search}%`;
      const sourceClause = authMode === 'platform' ? " AND directory_source = 'platform'" : '';
      const employees = db.prepare(`SELECT employee_key AS employeeKey, display_name AS name, department FROM employees WHERE active = 1${sourceClause} AND (? = '' OR display_name LIKE ? OR department LIKE ?) ORDER BY display_name LIMIT 50`).all(search, like, like).map(item => ({ ...item, source: authMode === 'platform' ? '小Q成员组' : '本地演示通讯录' }));
      return json(res, 200, { employees, source: authMode, sync });
    }
    if (url.pathname === '/api/admin/roles' && req.method === 'GET') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '没有权限管理授权'); return; }
      const directorySync = directorySyncState();
      const roles = db.prepare('SELECT role_key AS key, role_name AS name, description FROM roles ORDER BY role_key').all();
      const assignments = db.prepare('SELECT er.employee_key AS employeeKey, e.display_name AS employeeName, er.role_key AS roleKey, r.role_name AS roleName FROM employee_roles er JOIN employees e ON e.employee_key = er.employee_key JOIN roles r ON r.role_key = er.role_key ORDER BY e.display_name').all();
      const scopes = db.prepare('SELECT role_key AS roleKey, report_type AS reportType, access_level AS level, action, company_key AS companyKey, from_period AS fromPeriod, to_period AS toPeriod FROM role_report_scopes ORDER BY role_key, report_type, access_level, action').all();
      const accountVisibility = db.prepare('SELECT role_key AS roleKey, visibility FROM role_account_visibility ORDER BY role_key').all();
      const detailPreferences = db.prepare('SELECT role_key AS roleKey, show_direction AS showDirection, show_full_entry AS showFullEntry FROM role_detail_preferences ORDER BY role_key').all().map(item => ({ ...item, showDirection: Number(item.showDirection) === 1, showFullEntry: Number(item.showFullEntry) === 1 }));
      const employees = db.prepare(`SELECT employee_key AS employeeKey, display_name AS name, department FROM employees WHERE active = 1${authMode === 'platform' ? " AND directory_source = 'platform'" : ''} ORDER BY display_name`).all();
      const profiles = employees.map(item => ({ ...permissionProfileFor(item.employeeKey), name: item.name, department: item.department }));
      const roleDefaults = roles.map(role => ({ ...roleDefaultFor(role.key), name: role.name, description: role.description }));
      return json(res, 200, { roles, assignments, scopes, accountVisibility, detailPreferences, employees, profiles, roleDefaults, permissionCatalog, moduleOrder: moduleOrderFor(), directorySync });
    }
    if (url.pathname === '/api/admin/employee-permission-profile' && req.method === 'DELETE') {
      const actor = requireEmployee(req, res); if (!actor || !hasModule(actor.employee_key, 'permission_admin', 'manage')) { if (actor) bad(res, 403, '没有权限移除员工授权'); return; }
      const body = await parseBody(req); const employeeKey = String(body.employeeKey || '');
      const target = db.prepare('SELECT display_name AS name FROM employees WHERE employee_key = ? AND active = 1').get(employeeKey);
      if (!target) return bad(res, 404, '员工不存在或已停用');
      if (employeeKey === actor.employee_key) return bad(res, 400, '不能移除自己当前使用的权限管理能力');
      const remove = db.transaction(() => {
        const profile = db.prepare('DELETE FROM employee_permission_profiles WHERE employee_key = ?').run(employeeKey).changes;
        const roles = db.prepare('DELETE FROM employee_roles WHERE employee_key = ?').run(employeeKey).changes;
        return profile + roles;
      });
      const removed = remove(); log(actor.employee_key, 'remove_employee_permissions', employeeKey, `removed_records=${removed}`);
      return json(res, 200, { ok: true, removed, profile: permissionProfileFor(employeeKey) });
    }
    if (url.pathname === '/api/admin/employee-permission-profile' && req.method === 'POST') {
      const actor = requireEmployee(req, res); if (!actor || !hasModule(actor.employee_key, 'permission_admin', 'manage')) { if (actor) bad(res, 403, '没有权限管理授权'); return; }
      const body = await parseBody(req); const employeeKey = String(body.employeeKey || ''); const presetRoleKey = String(body.presetRoleKey || '');
      const target = db.prepare('SELECT 1 FROM employees WHERE employee_key = ? AND active = 1').get(employeeKey); const role = db.prepare('SELECT 1 FROM roles WHERE role_key = ?').get(presetRoleKey);
      const permissionKeys = [...new Set(Array.isArray(body.permissionKeys) ? body.permissionKeys.map(String) : [])].sort();
      const requestedCompanies = [...new Set(Array.isArray(body.companyKeys) ? body.companyKeys.map(String) : [])]; const companyKeys = requestedCompanies.includes('*') ? ['*'] : requestedCompanies;
      const fromPeriod = String(body.fromPeriod || ''); const toPeriod = String(body.toPeriod || '');
      if (!target || !role) return bad(res, 400, '员工或角色预设不存在');
      if (permissionKeys.some(key => !validPermissionKeys.has(key))) return bad(res, 400, '权限树包含无效权限');
      for (const [pageKey, definition] of Object.entries(analysisBlockPermissionDefinitions)) {
        const parentKey = `module.${pageKey}.view`;
        if (analysisBlockPermissionKeys(pageKey).some(key => permissionKeys.includes(key)) && !permissionKeys.includes(parentKey)) return bad(res, 400, `查看${definition.pageName}子模块前，需先开启${definition.pageName}浏览权限`);
      }
      if (permissionKeys.includes(financialBriefNotesPermissionKey) && !permissionKeys.includes('module.financial_brief.view')) return bad(res, 400, '编辑简报二级项目前，需先开启财务数据简报浏览权限');
      if (permissionKeys.includes(intercompanyDetailPermissionKey) && !permissionKeys.includes(intercompanyViewPermissionKey)) return bad(res, 400, '查看双方序时账明细前，需先开启各公司往来校验浏览权限');
      if (!Array.isArray(body.companyKeys) || companyKeys.some(key => key !== '*' && !db.prepare('SELECT 1 FROM companies WHERE company_key = ?').get(key))) return bad(res, 400, '请选择有效的公司范围');
      if (!/^\d{4}-\d{2}$/.test(fromPeriod) || !/^\d{4}-\d{2}$/.test(toPeriod) || fromPeriod > toPeriod) return bad(res, 400, '期间范围无效');
      if (!['level1', 'full'].includes(body.accountVisibility)) return bad(res, 400, '科目名称显示级别无效');
      if (employeeKey === actor.employee_key && !permissionKeys.includes('module.permissions.manage')) return bad(res, 400, '不能移除自己当前使用的权限管理能力');
      const save = db.transaction(() => {
        db.prepare(`INSERT INTO employee_permission_profiles(employee_key, preset_role_key, permission_keys_json, company_keys_json, from_period, to_period, account_visibility, show_direction, show_full_entry, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(employee_key) DO UPDATE SET preset_role_key = excluded.preset_role_key, permission_keys_json = excluded.permission_keys_json, company_keys_json = excluded.company_keys_json, from_period = excluded.from_period, to_period = excluded.to_period, account_visibility = excluded.account_visibility, show_direction = excluded.show_direction, show_full_entry = excluded.show_full_entry, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(employeeKey, presetRoleKey, JSON.stringify(permissionKeys), JSON.stringify(companyKeys), fromPeriod, toPeriod, body.accountVisibility, body.showDirection === false ? 0 : 1, body.showFullEntry === false ? 0 : 1, actor.employee_key, now());
        db.prepare('DELETE FROM employee_roles WHERE employee_key = ?').run(employeeKey);
        db.prepare('INSERT INTO employee_roles(employee_key, role_key) VALUES (?, ?)').run(employeeKey, presetRoleKey);
      });
      save(); const preset = roleDefaultFor(presetRoleKey); const changes = permissionKeys.filter(key => !preset.permissionKeys.includes(key)).length + preset.permissionKeys.filter(key => !permissionKeys.includes(key)).length;
      log(actor.employee_key, 'save_employee_permission_profile', employeeKey, `preset=${presetRoleKey};permissions=${permissionKeys.length};changes=${changes};companies=${companyKeys.join(',')};period=${fromPeriod}~${toPeriod}`);
      return json(res, 200, { ok: true, profile: permissionProfileFor(employeeKey), changes });
    }
    if (url.pathname === '/api/admin/assign-role' && req.method === 'POST') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '没有权限管理授权'); return; }
      const body = await parseBody(req); if (!body.employeeKey || !body.roleKey || !db.prepare('SELECT 1 FROM employees WHERE employee_key = ? AND active = 1').get(body.employeeKey) || !db.prepare('SELECT 1 FROM roles WHERE role_key = ?').get(body.roleKey)) return bad(res, 400, '员工或角色不存在');
      const assign = db.transaction(() => { db.prepare('DELETE FROM employee_permission_profiles WHERE employee_key = ?').run(body.employeeKey); db.prepare('INSERT OR IGNORE INTO employee_roles(employee_key, role_key) VALUES (?, ?)').run(body.employeeKey, body.roleKey); });
      assign(); log(employee.employee_key, 'assign_role', body.employeeKey, body.roleKey); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/admin/copy-employee-permissions' && req.method === 'POST') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '没有权限管理授权'); return; }
      const body = await parseBody(req); const sourceKey = body.sourceEmployeeKey; const targetKey = body.targetEmployeeKey;
      if (!sourceKey || !targetKey || sourceKey === targetKey) return bad(res, 400, '源员工和目标员工必须不同');
      if (!db.prepare('SELECT 1 FROM employees WHERE employee_key = ? AND active = 1').get(sourceKey) || !db.prepare('SELECT 1 FROM employees WHERE employee_key = ? AND active = 1').get(targetKey)) return bad(res, 400, '源员工或目标员工不存在');
      const sourceProfile = permissionProfileFor(sourceKey);
      const copy = db.transaction(() => {
        db.prepare('DELETE FROM employee_roles WHERE employee_key = ?').run(targetKey);
        db.prepare('INSERT INTO employee_roles(employee_key, role_key) VALUES (?, ?)').run(targetKey, sourceProfile.presetRoleKey);
        db.prepare(`INSERT INTO employee_permission_profiles(employee_key, preset_role_key, permission_keys_json, company_keys_json, from_period, to_period, account_visibility, show_direction, show_full_entry, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(employee_key) DO UPDATE SET preset_role_key = excluded.preset_role_key, permission_keys_json = excluded.permission_keys_json, company_keys_json = excluded.company_keys_json, from_period = excluded.from_period, to_period = excluded.to_period, account_visibility = excluded.account_visibility, show_direction = excluded.show_direction, show_full_entry = excluded.show_full_entry, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(targetKey, sourceProfile.presetRoleKey, JSON.stringify(sourceProfile.permissionKeys), JSON.stringify(sourceProfile.companyKeys), sourceProfile.fromPeriod, sourceProfile.toPeriod, sourceProfile.accountVisibility, sourceProfile.showDirection ? 1 : 0, sourceProfile.showFullEntry ? 1 : 0, employee.employee_key, now());
      });
      copy();
      const roleKeys = db.prepare('SELECT role_key AS roleKey FROM employee_roles WHERE employee_key = ? ORDER BY role_key').all(targetKey).map(row => row.roleKey);
      log(employee.employee_key, 'copy_employee_permissions', targetKey, `from=${sourceKey};roles=${roleKeys.join(',')};permissions=${sourceProfile.permissionKeys.length}`);
      return json(res, 200, { ok: true, sourceEmployeeKey: sourceKey, targetEmployeeKey: targetKey, roleKeys, profile: permissionProfileFor(targetKey) });
    }
    if (url.pathname === '/api/admin/set-account-visibility' && req.method === 'POST') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '没有权限管理授权'); return; }
      const body = await parseBody(req); if (!body.roleKey || !['level1', 'full'].includes(body.visibility) || !db.prepare('SELECT 1 FROM roles WHERE role_key = ?').get(body.roleKey)) return bad(res, 400, '角色或科目名称级别无效');
      db.prepare('INSERT INTO role_account_visibility(role_key, visibility) VALUES (?, ?) ON CONFLICT(role_key) DO UPDATE SET visibility = excluded.visibility').run(body.roleKey, body.visibility); log(employee.employee_key, 'set_account_visibility', body.roleKey, body.visibility); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/admin/set-detail-preference' && req.method === 'POST') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '没有权限管理授权'); return; }
      const body = await parseBody(req); const rawShowDirection = body.showDirection; const rawShowFullEntry = body.showFullEntry;
      const validBoolean = value => value === true || value === false || value === 1 || value === 0 || value === '1' || value === '0';
      if (!body.roleKey || (!validBoolean(rawShowDirection) && !validBoolean(rawShowFullEntry)) || !db.prepare('SELECT 1 FROM roles WHERE role_key = ?').get(body.roleKey)) return bad(res, 400, '角色或明细显示设置无效');
      db.prepare('INSERT OR IGNORE INTO role_detail_preferences(role_key, show_direction, show_full_entry) VALUES (?, 1, 1)').run(body.roleKey);
      if (validBoolean(rawShowDirection)) db.prepare('UPDATE role_detail_preferences SET show_direction = ? WHERE role_key = ?').run(rawShowDirection === true || rawShowDirection === 1 || rawShowDirection === '1' ? 1 : 0, body.roleKey);
      if (validBoolean(rawShowFullEntry)) db.prepare('UPDATE role_detail_preferences SET show_full_entry = ? WHERE role_key = ?').run(rawShowFullEntry === true || rawShowFullEntry === 1 || rawShowFullEntry === '1' ? 1 : 0, body.roleKey);
      const saved = db.prepare('SELECT show_direction AS showDirection, show_full_entry AS showFullEntry FROM role_detail_preferences WHERE role_key = ?').get(body.roleKey);
      log(employee.employee_key, 'set_detail_preference', body.roleKey, `showDirection=${saved.showDirection};showFullEntry=${saved.showFullEntry}`);
      return json(res, 200, { ok: true, roleKey: body.roleKey, showDirection: Number(saved.showDirection) === 1, showFullEntry: Number(saved.showFullEntry) === 1 });
    }
    return bad(res, 404, '接口不存在');
  } catch (error) { console.error(error); return bad(res, 500, process.env.NODE_ENV === 'production' ? '服务内部错误' : error.message); }
});

const port = Number(process.env.PORT || 3180);
const host = String(process.env.HOST || '127.0.0.1').trim();
if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('HOST 仅支持 127.0.0.1 或 0.0.0.0');
server.listen(port, host, () => console.log(`桉侨集团财务报表看板 v${appVersion} (${authMode}) listening on http://${host}:${port}`));

export { db, server, hasReport };
