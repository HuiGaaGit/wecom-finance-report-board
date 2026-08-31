import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
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
const appVersion = '1.1.5';
const financialBriefModuleKey = 'financial_brief';
const revenueProfitReportType = 'revenue_profit_consolidated_income_statement';
const revenueStatisticsReportType = 'revenue_statistics';
const groupStatementReportTypes = new Set(['consolidated_income_statement', revenueProfitReportType]);
const groupOnlyReportTypes = new Set([...groupStatementReportTypes, revenueStatisticsReportType]);
const authMode = String(process.env.AUTH_MODE || (process.env.NODE_ENV === 'production' ? 'wecom' : 'demo')).trim().toLowerCase();
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const rawBasePath = String(process.env.APP_BASE_PATH || '').trim();
const appBasePath = rawBasePath && rawBasePath !== '/' ? `/${rawBasePath.replace(/^\/+|\/+$/g, '')}` : '';
if (appBasePath && !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(appBasePath)) throw new Error('APP_BASE_PATH 必须是安全的绝对路径前缀，例如 /report');
const appPath = pathname => `${appBasePath}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
const sessionSecret = String(process.env.SESSION_SECRET || (authMode === 'demo' ? 'local-demo-session-secret' : ''));
const wecomConfig = {
  corpId: String(process.env.WECOM_CORP_ID || '').trim(),
  agentId: String(process.env.WECOM_AGENT_ID || '').trim(),
  secret: String(process.env.WECOM_SECRET || '').trim(),
  bootstrapAdminUserid: String(process.env.WECOM_BOOTSTRAP_ADMIN_USERID || '').trim()
};
const wecomApiBaseUrl = process.env.NODE_ENV === 'test' && process.env.WECOM_API_BASE_URL
  ? String(process.env.WECOM_API_BASE_URL).trim().replace(/\/+$/, '')
  : 'https://qyapi.weixin.qq.com';
const wecomDirectorySyncEnabled = process.env.WECOM_DIRECTORY_SYNC_ENABLED === '1';
if (!['demo', 'wecom'].includes(authMode)) throw new Error('AUTH_MODE 仅支持 demo 或 wecom');
if (authMode === 'wecom') {
  const missing = [['PUBLIC_BASE_URL', publicBaseUrl], ['SESSION_SECRET', sessionSecret], ['WECOM_CORP_ID', wecomConfig.corpId], ['WECOM_AGENT_ID', wecomConfig.agentId], ['WECOM_SECRET', wecomConfig.secret], ['WECOM_BOOTSTRAP_ADMIN_USERID', wecomConfig.bootstrapAdminUserid]].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`企微生产认证缺少环境变量：${missing.join(', ')}`);
  if (!/^https:\/\//i.test(publicBaseUrl)) throw new Error('企微生产认证要求 PUBLIC_BASE_URL 使用 HTTPS');
  if (new URL(publicBaseUrl).pathname.replace(/\/+$/, '') !== appBasePath) throw new Error('PUBLIC_BASE_URL 路径必须与 APP_BASE_PATH 一致');
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET 至少需要 32 个字符');
}
const dbFile = process.env.DB_FILE || path.join(dataDir, 'report-board.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
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
  created_at TEXT NOT NULL
);
`);

const employeeColumns = new Set(db.prepare('PRAGMA table_info(employees)').all().map(column => column.name));
if (!employeeColumns.has('directory_source')) db.exec("ALTER TABLE employees ADD COLUMN directory_source TEXT NOT NULL DEFAULT 'local'");
if (!employeeColumns.has('directory_synced_at')) db.exec('ALTER TABLE employees ADD COLUMN directory_synced_at TEXT');

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
    ['group_profit_analysis', '集团合并利润趋势图']
  ].forEach(row => addModule.run(...row));
  const addCompany = db.prepare('INSERT INTO companies(company_key, company_name) VALUES (?, ?)');
  [['group', '桉侨集团'], ['gz', '广州桉侨'], ['sz', '深圳桉侨'], ['qd', '青岛桉侨']].forEach(row => addCompany.run(...row));
  const addType = db.prepare('INSERT INTO report_types(report_type, report_name) VALUES (?, ?)');
  [['balance_sheet', '资产负债表'], ['income_statement', '利润表'], ['consolidated_income_statement', '桉侨集团合并利润表'], [revenueProfitReportType, '（营收利润口径）合并利润表'], [revenueStatisticsReportType, '营收统计表'], ['cash_flow', '现金流量表']].forEach(row => addType.run(...row));
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
db.prepare('INSERT OR IGNORE INTO modules(module_key, module_name) VALUES (?, ?)').run(financialBriefModuleKey, '财务数据简报');
db.prepare("INSERT OR IGNORE INTO companies(company_key, company_name) VALUES ('qd', '青岛桉侨')").run();
db.prepare("INSERT OR IGNORE INTO companies(company_key, company_name) VALUES ('group', '桉侨集团')").run();
for (const row of [['admin', 'database_admin', 'view'], ['admin', 'database_admin', 'manage']]) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(...row);
for (const row of [['admin', 'main_business_analysis', 'view'], ['manager', 'main_business_analysis', 'view']]) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(...row);
for (const row of [['admin', 'expense_analysis', 'view'], ['manager', 'expense_analysis', 'view']]) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(...row);
for (const row of [['admin', 'group_profit_analysis', 'view'], ['manager', 'group_profit_analysis', 'view']]) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(...row);
for (const role of ['admin', 'manager', 'accountant', 'viewer']) db.prepare('INSERT OR IGNORE INTO role_permissions(role_key, module_key, action) VALUES (?, ?, ?)').run(role, financialBriefModuleKey, 'view');
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
for (const role of ['admin', 'manager', 'viewer']) for (const type of groupOnlyReportTypes) {
  for (const action of role === 'viewer' ? ['view'] : ['view', 'export']) db.prepare('INSERT OR IGNORE INTO role_report_scopes(role_key, report_type, access_level, action, company_key, from_period, to_period) VALUES (?, ?, ?, ?, ?, ?, ?)').run(role, type, 'summary', action, 'group', '2020-01', '2099-12');
}
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
  [financialBriefModuleKey, 10], ['balance_sheet', 20], ['income_statement', 30], ['consolidated_income_statement', 35], [revenueProfitReportType, 36], ['group_profit_analysis', 37], [revenueStatisticsReportType, 38], ['cash_flow', 40],
  ['trial_balance', 50], ['journal', 60], ['cash_analysis', 70], ['main_business_analysis', 80], ['expense_analysis', 90], ['uploads', 100], ['permissions', 110], ['database_admin', 120]
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
const analysisBlockDefaults = {
  cash_analysis: ['cash_metric', 'internal_metric', 'core_metric', 'receivables_metric', 'static_metric', 'liquidity_guide', 'cash_source', 'net_positions', 'cash_accounts', 'other_liquidity', 'core_liquidity_trend'],
  main_business_analysis: ['business_source', 'revenue_metric', 'cost_metric', 'gross_metric', 'project_count_metric', 'business_detail', 'project_change', 'gross_trend'],
  expense_analysis: ['expense_source', 'selling_table', 'selling_share', 'selling_trend', 'admin_table', 'admin_share', 'admin_trend', 'finance_table', 'finance_share', 'finance_methods'],
  group_profit_analysis: ['group_profit_source', 'revenue_cost_trend', 'period_expense_trend', 'net_profit_trend']
};
for (const [pageKey, keys] of Object.entries(analysisBlockDefaults)) keys.forEach((blockKey, index) => db.prepare('INSERT OR IGNORE INTO analysis_block_order(page_key, block_key, sort_order) VALUES (?, ?, ?)').run(pageKey, blockKey, (index + 1) * 10));
const analysisBlockOrderFor = pageKey => {
  const keys = analysisBlockDefaults[pageKey] || [];
  const known = new Set(db.prepare('SELECT block_key AS key FROM analysis_block_order WHERE page_key = ?').all(pageKey).map(row => row.key));
  keys.forEach((key, index) => { if (!known.has(key)) db.prepare('INSERT OR IGNORE INTO analysis_block_order(page_key, block_key, sort_order) VALUES (?, ?, ?)').run(pageKey, key, (index + 1) * 10); });
  return db.prepare('SELECT block_key AS key FROM analysis_block_order WHERE page_key = ? ORDER BY sort_order, block_key').all(pageKey).map(row => row.key).filter(key => keys.includes(key));
};
const allAnalysisBlockOrders = () => Object.fromEntries(Object.keys(analysisBlockDefaults).map(pageKey => [pageKey, analysisBlockOrderFor(pageKey)]));
const uploadsDir = process.env.UPLOADS_DIR || path.join(dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const json = (res, status, value) => { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
const text = (res, status, value, contentType = 'text/plain; charset=utf-8') => { res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' }); res.end(value); };
const redirect = (res, location, headers = {}) => { res.writeHead(302, { location, 'cache-control': 'no-store', ...headers }); res.end(); };
const bad = (res, status, message) => json(res, status, { error: message });
const sessionCookieName = 'wecom_finance_session';
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
const sessionCookie = employeeKey => `${sessionCookieName}=${encodeURIComponent(signPayload({ type: 'session', sub: employeeKey, exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60 }))}; Path=${sessionCookiePath}; HttpOnly; SameSite=Lax; Max-Age=28800${publicBaseUrl.startsWith('https://') ? '; Secure' : ''}`;
const clearSessionCookie = () => `${sessionCookieName}=; Path=${sessionCookiePath}; HttpOnly; SameSite=Lax; Max-Age=0${publicBaseUrl.startsWith('https://') ? '; Secure' : ''}`;
const employeeFrom = req => {
  const key = authMode === 'demo' ? (req.headers['x-demo-employee'] || process.env.DEV_EMPLOYEE || 'admin') : verifyPayload(parseCookies(req)[sessionCookieName])?.sub;
  return key ? db.prepare('SELECT * FROM employees WHERE employee_key = ? AND active = 1').get(key) : null;
};
let wecomTokenCache = { value: '', expiresAt: 0 };
const wecomTicketCache = new Map();
const wecomJson = async url => { const response = await fetch(url, { signal: AbortSignal.timeout(10000) }); const payload = await response.json().catch(() => ({})); if (!response.ok || Number(payload.errcode || 0) !== 0) throw new Error(`企业微信接口失败：${payload.errmsg || response.status}`); return payload; };
const wecomApiUrl = (pathname, parameters = {}) => `${wecomApiBaseUrl}${pathname}?${new URLSearchParams(parameters)}`;
const wecomAccessToken = async () => {
  if (wecomTokenCache.value && wecomTokenCache.expiresAt > Date.now() + 60_000) return wecomTokenCache.value;
  const payload = await wecomJson(wecomApiUrl('/cgi-bin/gettoken', { corpid: wecomConfig.corpId, corpsecret: wecomConfig.secret }));
  wecomTokenCache = { value: payload.access_token, expiresAt: Date.now() + Math.max(300, Number(payload.expires_in || 7200) - 120) * 1000 }; return wecomTokenCache.value;
};
const wecomJsApiTicket = async type => {
  const cached = wecomTicketCache.get(type);
  if (cached?.value && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const token = await wecomAccessToken();
  const pathname = type === 'agent_config' ? '/cgi-bin/ticket/get' : '/cgi-bin/get_jsapi_ticket';
  const parameters = type === 'agent_config' ? { access_token: token, type } : { access_token: token };
  const payload = await wecomJson(wecomApiUrl(pathname, parameters));
  const value = String(payload.ticket || '');
  if (!value) throw new Error('企业微信接口未返回 JS-SDK ticket');
  wecomTicketCache.set(type, { value, expiresAt: Date.now() + Math.max(300, Number(payload.expires_in || 7200) - 120) * 1000 });
  return value;
};
const wecomJsSdkSignature = (ticket, nonceStr, timestamp, url) => crypto.createHash('sha1').update(`jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`).digest('hex');
const normalizeSharePageUrl = value => {
  const candidate = new URL(String(value || '')); const base = new URL(publicBaseUrl);
  const allowedPath = `${appBasePath || ''}/`.replace(/\/+/g, '/');
  if (candidate.origin !== base.origin || ![appBasePath || '/', allowedPath].includes(candidate.pathname)) throw new Error('分享页面地址不属于当前应用');
  candidate.hash = '';
  return candidate.toString();
};
function directoryDepartmentPath(departmentId, departments) {
  const names = []; const seen = new Set(); let current = String(departmentId || '');
  while (current && departments.has(current) && !seen.has(current)) {
    seen.add(current); const department = departments.get(current);
    if (department.name) names.unshift(String(department.name));
    current = String(department.parentid || department.parent_id || '');
  }
  return names.join(' / ') || '企业微信通讯录';
}
const wecomDepartmentPath = async (token, departmentId) => {
  if (!departmentId) return '企业微信通讯录';
  try {
    const payload = await wecomJson(wecomApiUrl('/cgi-bin/department/list', { access_token: token, id: 1 }));
    const departments = new Map((payload.department || []).map(item => [String(item.id), item]));
    return directoryDepartmentPath(departmentId, departments);
  } catch { return '企业微信通讯录'; }
};
const syncWecomEmployee = async userid => {
  const token = await wecomAccessToken(); const profile = await wecomJson(wecomApiUrl('/cgi-bin/user/get', { access_token: token, userid }));
  const employeeKey = String(profile.userid || userid); const displayName = String(profile.name || profile.alias || employeeKey).slice(0, 80); const departmentId = profile.main_department || (Array.isArray(profile.department) ? profile.department[0] : ''); const department = await wecomDepartmentPath(token, departmentId);
  const existed = db.prepare('SELECT 1 FROM employees WHERE employee_key = ?').get(employeeKey);
  db.prepare("INSERT INTO employees(employee_key, display_name, department, active, directory_source, directory_synced_at) VALUES (?, ?, ?, 1, 'wecom', ?) ON CONFLICT(employee_key) DO UPDATE SET display_name = excluded.display_name, department = excluded.department, active = 1, directory_source = 'wecom', directory_synced_at = excluded.directory_synced_at").run(employeeKey, displayName, department, now());
  if (employeeKey === wecomConfig.bootstrapAdminUserid) db.prepare("INSERT OR IGNORE INTO employee_roles(employee_key, role_key) VALUES (?, 'admin')").run(employeeKey);
  else if (!existed && !db.prepare('SELECT 1 FROM employee_permission_profiles WHERE employee_key = ?').get(employeeKey)) db.prepare("INSERT INTO employee_permission_profiles(employee_key, preset_role_key, permission_keys_json, company_keys_json, from_period, to_period, account_visibility, show_direction, show_full_entry, updated_by, updated_at) VALUES (?, 'viewer', '[]', '[]', '2020-01', '2099-12', 'level1', 0, 0, 'wecom_oauth', ?)").run(employeeKey, now());
  return db.prepare('SELECT * FROM employees WHERE employee_key = ?').get(employeeKey);
};
const directorySyncState = () => {
  const row = db.prepare('SELECT status, last_attempt_at AS lastAttemptAt, last_success_at AS lastSuccessAt, last_error AS lastError, employee_count AS employeeCount FROM directory_sync_state WHERE source = ?').get('wecom');
  return row || { status: authMode === 'wecom' ? (wecomDirectorySyncEnabled ? 'never' : 'disabled') : 'demo', lastAttemptAt: null, lastSuccessAt: null, lastError: '', employeeCount: authMode === 'demo' ? db.prepare('SELECT COUNT(*) AS count FROM employees WHERE active = 1').get().count : 0 };
};
const wecomVisibleDirectory = async token => {
  const agent = await wecomJson(wecomApiUrl('/cgi-bin/agent/get', { access_token: token, agentid: wecomConfig.agentId }));
  const departmentIds = new Set((agent.allow_partys?.partyid || []).map(String));
  const directUserIds = new Set((agent.allow_userinfos?.user || []).map(item => String(item.userid || '')).filter(Boolean));
  const tagIds = (agent.allow_tags?.tagid || []).map(String);
  const departments = new Map(); const members = new Map();
  try {
    const payload = await wecomJson(wecomApiUrl('/cgi-bin/department/list', { access_token: token, id: 1 }));
    for (const item of payload.department || []) departments.set(String(item.id), item);
  } catch {}
  for (const tagId of tagIds) {
    const tag = await wecomJson(wecomApiUrl('/cgi-bin/tag/get', { access_token: token, tagid: tagId }));
    for (const item of tag.userlist || []) {
      if (!item.userid) continue;
      directUserIds.add(String(item.userid));
      if (item.name) members.set(String(item.userid), item);
    }
    for (const departmentId of tag.partylist || []) departmentIds.add(String(departmentId));
  }
  if (!departmentIds.size && !directUserIds.size) departmentIds.add('1');
  for (const departmentId of departmentIds) {
    try {
      const payload = await wecomJson(wecomApiUrl('/cgi-bin/department/list', { access_token: token, id: departmentId }));
      for (const item of payload.department || []) departments.set(String(item.id), item);
    } catch {}
    const payload = await wecomJson(wecomApiUrl('/cgi-bin/user/simplelist', { access_token: token, department_id: departmentId, fetch_child: 1 }));
    for (const item of payload.userlist || []) if (item.userid && item.name) members.set(String(item.userid), item);
  }
  for (const userid of directUserIds) {
    if (members.get(userid)?.name) continue;
    const profile = await wecomJson(wecomApiUrl('/cgi-bin/user/get', { access_token: token, userid }));
    if (profile.userid && profile.name) members.set(String(profile.userid), profile);
  }
  return { departments, members: [...members.values()] };
};
let wecomDirectorySyncPromise = null;
const syncWecomDirectory = async ({ force = false } = {}) => {
  if (authMode !== 'wecom') return directorySyncState();
  if (!wecomDirectorySyncEnabled) return directorySyncState();
  const previous = directorySyncState(); const lastSuccess = Date.parse(previous.lastSuccessAt || '');
  if (!force && Number.isFinite(lastSuccess) && Date.now() - lastSuccess < 5 * 60 * 1000) return previous;
  if (wecomDirectorySyncPromise) return wecomDirectorySyncPromise;
  wecomDirectorySyncPromise = (async () => {
    const attemptedAt = now();
    db.prepare("INSERT INTO directory_sync_state(source, status, last_attempt_at, last_error, employee_count) VALUES ('wecom', 'syncing', ?, '', ?) ON CONFLICT(source) DO UPDATE SET status = 'syncing', last_attempt_at = excluded.last_attempt_at, last_error = ''").run(attemptedAt, Number(previous.employeeCount || 0));
    try {
      const token = await wecomAccessToken();
      const { departments, members } = await wecomVisibleDirectory(token);
      if (!members.length) throw new Error('企业微信接口未返回应用可见员工，请在企微后台配置应用可见范围');
      const syncedAt = now();
      const save = db.transaction(() => {
        const upsert = db.prepare("INSERT INTO employees(employee_key, display_name, department, active, directory_source, directory_synced_at) VALUES (?, ?, ?, 1, 'wecom', ?) ON CONFLICT(employee_key) DO UPDATE SET display_name = excluded.display_name, department = excluded.department, active = 1, directory_source = 'wecom', directory_synced_at = excluded.directory_synced_at");
        for (const member of members) {
          const mainDepartment = member.main_department || (Array.isArray(member.department) ? member.department[0] : '');
          upsert.run(String(member.userid), String(member.name).slice(0, 80), directoryDepartmentPath(mainDepartment, departments), syncedAt);
        }
        db.prepare("INSERT INTO directory_sync_state(source, status, last_attempt_at, last_success_at, last_error, employee_count) VALUES ('wecom', 'success', ?, ?, '', ?) ON CONFLICT(source) DO UPDATE SET status = 'success', last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at, last_error = '', employee_count = excluded.employee_count").run(attemptedAt, syncedAt, members.length);
      });
      save(); log(wecomConfig.bootstrapAdminUserid, 'sync_wecom_directory', 'wecom_directory', `employees=${members.length}`);
      return directorySyncState();
    } catch (error) {
      const message = String(error?.message || '企业微信通讯录同步失败').slice(0, 300);
      db.prepare("INSERT INTO directory_sync_state(source, status, last_attempt_at, last_error, employee_count) VALUES ('wecom', 'failed', ?, ?, ?) ON CONFLICT(source) DO UPDATE SET status = 'failed', last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error").run(attemptedAt, message, Number(previous.employeeCount || 0));
      throw error;
    } finally { wecomDirectorySyncPromise = null; }
  })();
  return wecomDirectorySyncPromise;
};
const syncWecomDirectorySafely = async options => { try { return await syncWecomDirectory(options); } catch { return directorySyncState(); } };
const wecomLoginUrl = () => {
  const state = signPayload({ type: 'oauth', exp: Math.floor(Date.now() / 1000) + 10 * 60 }); const redirectUri = `${publicBaseUrl}/auth/wecom/callback`;
  return `https://open.weixin.qq.com/connect/oauth2/authorize?${new URLSearchParams({ appid: wecomConfig.corpId, redirect_uri: redirectUri, response_type: 'code', scope: 'snsapi_base', agentid: wecomConfig.agentId, state }).toString()}#wechat_redirect`;
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
const permissionCatalog = [
  { id: 'reports', name: '财务报表', description: '每张报表的浏览、明细和导出独立控制', children: [
    reportPermissionNode('balance_sheet', '资产负债表'), reportPermissionNode('income_statement', '利润表'), summaryReportPermissionNode('consolidated_income_statement', '桉侨集团合并利润表'), summaryReportPermissionNode(revenueProfitReportType, '（营收利润口径）合并利润表'), summaryReportPermissionNode(revenueStatisticsReportType, '营收统计表'), reportPermissionNode('cash_flow', '现金流量表'), reportPermissionNode('trial_balance', '科目余额表'), reportPermissionNode('journal', '序时账')
  ] },
  { id: 'analysis', name: '经营分析', description: '分析页只开放聚合结果，不自动开放底层序时账', children: [
    { key: 'module.financial_brief.view', name: '财务数据简报 · 浏览' },
    { key: 'module.cash_analysis.view', name: '资产净额分析 · 浏览' },
    { key: 'module.main_business_analysis.view', name: '主营业务分析 · 浏览' },
    { key: 'module.expense_analysis.view', name: '费用分析 · 浏览' },
    { key: 'module.group_profit_analysis.view', name: '集团合并利润趋势图 · 浏览' }
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
const modulePermissionKey = (moduleKey, action) => ({
  report_import: `module.uploads.${action}`,
  permission_admin: `module.permissions.${action}`,
  database_admin: `module.database.${action}`,
  cash_analysis: `module.cash_analysis.${action}`,
  main_business_analysis: `module.main_business_analysis.${action}`,
  expense_analysis: `module.expense_analysis.${action}`,
  [financialBriefModuleKey]: `module.financial_brief.${action}`,
  group_profit_analysis: `module.group_profit_analysis.${action}`
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
  return { employeeKey, presetRoleKey: roleKeys[0] || 'viewer', permissionKeys, companyKeys: companies.includes('*') || !companies.length ? ['*'] : companies, fromPeriod: defaults.map(item => item.fromPeriod).sort()[0] || '2020-01', toPeriod: defaults.map(item => item.toPeriod).sort().at(-1) || '2099-12', accountVisibility: defaults.some(item => item.accountVisibility === 'full') ? 'full' : 'level1', showDirection: defaults.length ? defaults.some(item => item.showDirection) : true, showFullEntry: defaults.length ? defaults.some(item => item.showFullEntry) : true, hasAssignment: roleKeys.length > 0, isCustomized: false, updatedAt: null };
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
const moduleNames = new Map([
  ['home', '首页'], [financialBriefModuleKey, '财务数据简报'], ['uploads', '上传报表'], ['cash_analysis', '资产净额分析'], ['main_business_analysis', '主营业务分析'], ['expense_analysis', '费用分析'], ['group_profit_analysis', '集团合并利润趋势图'], ['permissions', '权限管理'], ['database_admin', '数据库管理']
]);
const visibleModulesFor = (employeeKey, companyKey, period) => {
  const reportNames = new Map(db.prepare('SELECT report_type AS key, report_name AS name FROM report_types').all().map(row => [row.key, row.name]));
  const canManage = hasModule(employeeKey, 'permission_admin', 'manage');
  const canManageReportData = hasModule(employeeKey, 'database_admin', 'view');
  const canUpload = hasModule(employeeKey, 'report_import', 'upload');
  const visible = new Set();
  for (const type of reportNames.keys()) {
    const groupScopeMatches = companyKey === 'group' ? groupOnlyReportTypes.has(type) : !groupOnlyReportTypes.has(type);
    if (groupScopeMatches && hasModule(employeeKey, 'report_summary', 'view') && hasReport(employeeKey, type, 'summary', 'view', companyKey, period)) visible.add(type);
  }
  if (canUpload) visible.add('uploads');
  if (hasAnalysis(employeeKey, financialBriefModuleKey, companyKey, period)) visible.add(financialBriefModuleKey);
  if (companyKey !== 'group' && hasAnalysis(employeeKey, 'cash_analysis', companyKey, period)) visible.add('cash_analysis');
  if (companyKey !== 'group' && hasAnalysis(employeeKey, 'main_business_analysis', companyKey, period)) visible.add('main_business_analysis');
  if (companyKey !== 'group' && hasAnalysis(employeeKey, 'expense_analysis', companyKey, period)) visible.add('expense_analysis');
  if (companyKey === 'group' && hasAnalysis(employeeKey, 'group_profit_analysis', companyKey, period) && hasReport(employeeKey, 'consolidated_income_statement', 'summary', 'view', companyKey, period)) visible.add('group_profit_analysis');
  if (canManage) visible.add('permissions');
  if (canManageReportData) visible.add('database_admin');
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
const requireEmployee = (req, res) => { const employee = employeeFrom(req); if (!employee) { json(res, 401, { error: '请先通过企业微信身份认证', loginUrl: authMode === 'wecom' ? appPath('/auth/wecom') : '' }); return null; } return employee; };
const requireReport = (req, res, reportType, level, action, companyKey, period) => { const employee = requireEmployee(req, res); if (!employee) return null; const moduleKey = level === 'summary' ? 'report_summary' : 'report_detail'; if (!hasModule(employee.employee_key, moduleKey, action) || !hasReport(employee.employee_key, reportType, level, action, companyKey, period)) { bad(res, 403, '当前员工没有该报表层级或数据范围权限'); return null; } return employee; };
const log = (employeeKey, action, target, detail) => db.prepare('INSERT INTO audit_logs(employee_key, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(employeeKey, action, target, detail, now());

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
  return { analysis: 'main_business', company: companyRow(companyKey)?.company_name || companyKey, period, previousPeriod: prior, year, current: { revenue: roundedAmount(currentRows.filter(item => item.kind === 'revenue').reduce((sum, item) => sum + item.amount, 0)), cost: roundedAmount(currentRows.filter(item => item.kind === 'cost').reduce((sum, item) => sum + item.amount, 0)) }, detailRows, projectRows, monthlyTrend: monthly, source: { ...source.meta, sourceSheet: source.raw?.sourceSheet || '—' }, warnings };
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

const parseBody = req => new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 20 * 1024 * 1024) reject(new Error('请求体过大')); }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('请求体不是有效 JSON')); } }); req.on('error', reject); });
const requireImport = (req, res, action) => { const employee = requireEmployee(req, res); if (!employee) return null; if (!hasModule(employee.employee_key, 'report_import', action)) { bad(res, 403, '当前员工没有上传报表权限'); return null; } return employee; };
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
const revenueDimensionDefinitions = [
  { key: 'group', name: '集团维度', titlePattern: /集团维度/, tableKeys: ['B1', 'B2', 'B3'] },
  { key: 'direct', name: '单独直客维度', titlePattern: /单独直客维度/, tableKeys: ['B4', 'B5', 'B6'] },
  { key: 'channel', name: '单独渠道维度', titlePattern: /单独渠道维度/, tableKeys: ['B7', 'B8'] }
];
const parseRevenueStatisticsSheet = (workbook, sheetName) => {
  const sheet = workbook.Sheets[sheetName];
  const sheetRows = uploadSheetRows(sheet, sheetName); const rows = sheetRows.rows;
  const dimensionRowIndex = rows.findIndex(row => revenueDimensionDefinitions.every(definition => (row || []).some(value => definition.titlePattern.test(String(value || '')))));
  const tableTitleRowIndex = rows.findIndex(row => {
    const keys = (row || []).map(value => String(value || '').match(/B([1-8])\s*$/i)?.[0]?.toUpperCase()).filter(Boolean);
    return keys.includes('B1') && keys.includes('B8');
  });
  if (dimensionRowIndex < 0 || tableTitleRowIndex < 0) throw new Error('营收统计汇总表缺少三个维度标题或 B1-B8 二级表标题');
  const anchors = (rows[tableTitleRowIndex] || []).map((value, column) => {
    const title = String(value || '').trim(); const match = title.match(/B([1-8])\s*$/i);
    return match ? { key: `B${match[1]}`, title, column } : null;
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
  return { sourceSheet: sheetName, sourcePeriod: periodMatch ? `${periodMatch[1]}-${String(periodMatch[2]).padStart(2, '0')}` : '', hidden: Boolean(sheetMeta?.Hidden), maxRow: rows.length, maxCol: sheetRows.maxCol, declaredRange: sheetRows.declaredRange, effectiveRange: sheetRows.effectiveRange, rangeTrimmed: sheetRows.rangeTrimmed, note, dimensions };
};
const parseUploadedFile = (buffer, fileName, fileType) => {
  if (fileType === 'application/json' || fileName.toLowerCase().endsWith('.json')) {
    const parsed = JSON.parse(buffer.toString('utf8'));
    return ['balance_sheet', 'income_statement', 'consolidated_income_statement', revenueProfitReportType, revenueStatisticsReportType, 'cash_flow', 'trial_balance', 'journal'].some(type => parsed[type]) ? parsed : { uploaded: parsed };
  }
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const reports = {};
  const reportSheetPatterns = {
    balance_sheet: /^(?:(?:20\d{2}年)?\d{1,2}月)?资产负债表$/,
    income_statement: /^(?:(?:20\d{2}年)?\d{1,2}月)?利润表$/,
    consolidated_income_statement: /^(?:桉侨)?集团(?:合并)?利润表$/,
    [revenueProfitReportType]: /^(?:营收利润口径|营收口径)集团(?:合并)?利润表$/,
    [revenueStatisticsReportType]: /^(?:20\d{2}年)?数据统计汇总表[（(]?mia[）)]?$/i,
    cash_flow: /^(?:(?:20\d{2}年)?\d{1,2}月)?现金流量表(?:-钱去向)?$/,
    trial_balance: /^(?:(?:20\d{2}年)?\d{1,2}月)?科目余额表$/,
    journal: /^(?:(?:20\d{2}年)?\d{1,2}月)?序时账$/
  };
  for (const [type, pattern] of Object.entries(reportSheetPatterns)) {
    const sheetName = workbook.SheetNames.find(name => pattern.test(String(name).replace(/\s+/g, '')));
    if (!sheetName) continue;
    if (type === revenueStatisticsReportType) { reports[type] = parseRevenueStatisticsSheet(workbook, sheetName); continue; }
    const sheetRows = uploadSheetRows(workbook.Sheets[sheetName], sheetName); let rows = sheetRows.rows;
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
  if (!Object.keys(reports).length) throw new Error('未找到可识别的资产负债表、利润表、集团合并利润表、营收利润口径合并利润表、营收统计汇总表、现金流量表、科目余额表或序时账工作表');
  return reports;
};
const uploadPeriodHint = (fileName, reports, selectedPeriod) => {
  const sources = [fileName, ...Object.values(reports).flatMap(item => [item?.sourceSheet, item?.sourcePeriod])].filter(Boolean).map(String);
  const explicit = [];
  for (const source of sources) {
    for (const match of source.matchAll(/(20\d{2})\s*(?:年|[.\/_-])\s*(1[0-2]|0?[1-9])\s*月?/g)) explicit.push({ period: `${match[1]}-${String(match[2]).padStart(2, '0')}`, source });
  }
  const explicitPeriods = [...new Set(explicit.map(item => item.period))];
  const monthHints = [...new Set(sources.flatMap(source => [...source.matchAll(/(?:^|\D)(1[0-2]|0?[1-9])月/g)].map(match => String(match[1]).padStart(2, '0'))))];
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
  if (!trial.meta.noData) {
    const header = (trial.raw.rows || []).find(row => (row.cells || []).some(value => String(value || '').trim() === '本期发生额'));
    const currentDebitIndex = (header?.cells || []).findIndex(value => String(value || '').trim() === '本期发生额');
    if (currentDebitIndex >= 0) {
      const matched = (trial.raw.rows || []).map(row => ({ row, code: String(row.cells?.[0] || '').trim(), name: String(row.cells?.[1] || '').trim() }))
        .filter(item => /广宣费|广告费|业务宣传费|宣传费/.test(item.name));
      const leaves = matched.filter(item => !matched.some(other => other !== item && item.code && other.code.startsWith(item.code) && other.code.length > item.code.length));
      const debitAmount = roundedAmount(leaves.reduce((sum, item) => sum + Number(item.row.cells?.[currentDebitIndex] || 0), 0));
      const creditAmount = roundedAmount(leaves.reduce((sum, item) => sum + Number(item.row.cells?.[currentDebitIndex + 1] || 0), 0));
      return { available: true, amount: roundedAmount(debitAmount - creditAmount), debitAmount, creditAmount, basis: '本期发生额（借方－贷方）', source: trial.meta.fileName, sourceSheet: trial.raw.sourceSheet || '科目余额表', report: '科目余额表' };
    }
  }
  const journal = rawReportFor('journal', companyKey, period);
  if (journal.meta.noData) return { available: false, amount: null, source: '', sourceSheet: '', report: '科目余额表/序时账' };
  const rows = withoutProfitClosingEntries(journal.raw.rows || [], row => row.cells?.[2], row => row.cells?.[1]);
  const accountIndex = journalColumnIndex(journal.raw, '科目名称', 4);
  const debitIndex = journalColumnIndex(journal.raw, '借方金额', 5);
  const creditIndex = journalColumnIndex(journal.raw, '贷方金额', 6);
  const matchedRows = rows.filter(row => /销售费用/.test(String(row.cells?.[accountIndex] || '')) && /广宣费|广告费|业务宣传费|宣传费/.test(String(row.cells?.[accountIndex] || '')));
  const debitAmount = roundedAmount(matchedRows.reduce((sum, row) => sum + Number(row.cells?.[debitIndex] || 0), 0));
  const creditAmount = roundedAmount(matchedRows.reduce((sum, row) => sum + Number(row.cells?.[creditIndex] || 0), 0));
  return { available: true, amount: roundedAmount(debitAmount - creditAmount), debitAmount, creditAmount, basis: '序时账发生额（借方－贷方）', source: journal.meta.fileName, sourceSheet: journal.raw.sourceSheet || '序时账', report: '序时账' };
};
const financialBriefFor = (companyKey, period) => {
  const company = companyRow(companyKey);
  const groupRevenue = rawReportFor(revenueProfitReportType, 'group', period);
  const revenueRaw = companyKey === 'group' ? groupRevenue.raw : briefEntityForCompany(groupRevenue.raw, company);
  const standard = rawReportFor(companyKey === 'group' ? 'consolidated_income_statement' : 'income_statement', companyKey, period);
  const sources = []; const missing = []; const advertisingSources = [];
  const addSource = (report, fileName, scope = '', category = 'general') => { if (fileName && !sources.some(item => item.report === report && item.fileName === fileName && item.scope === scope && item.category === category)) sources.push({ report, fileName, scope, category }); };
  const addAdvertisingSource = (item, advertising) => advertisingSources.push({
    companyKey: item.company_key,
    companyName: item.company_name,
    available: advertising.available,
    amount: advertising.available ? advertising.amount : null,
    debitAmount: advertising.available ? advertising.debitAmount : null,
    creditAmount: advertising.available ? advertising.creditAmount : null,
    basis: advertising.basis || '',
    report: advertising.report,
    fileName: advertising.source,
    sourceSheet: advertising.sourceSheet || ''
  });
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
    addAdvertisingSource({ company_key: companyKey, company_name: company.company_name }, advertising);
    if (advertising.available) { advertisingExpense = advertising.amount; addSource(advertising.report, advertising.source, company.company_name, 'advertising'); }
    else missing.push(`广宣费来源缺少：${company.company_name}（科目余额表或序时账）`);
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
      addAdvertisingSource(item, advertising);
      if (!advertising.available) { advertisingComplete = false; advertisingMissingCompanies.push(item.company_name); }
      else { advertisingTotal += advertising.amount; addSource(advertising.report, advertising.source, item.company_name, 'advertising'); }
    }
    if (balanceComplete) accountBalance = roundedAmount(balanceTotal); else missing.push(`账户余额来源缺少：${balanceMissingCompanies.join('、') || '尚未识别集团子公司'}（资产负债表）`);
    if (advertisingComplete) advertisingExpense = roundedAmount(advertisingTotal); else missing.push(`广宣费来源缺少：${advertisingMissingCompanies.join('、') || '尚未识别集团子公司'}（科目余额表或序时账）`);
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
  return { company: company.company_name, companyKey, period, scopeLabel: companyKey === 'group' ? '集团方面' : `${company.company_name}方面`, metrics, sources, advertisingSources, missing: [...new Set(missing)], complete: missing.length === 0 };
};
const sendStatic = (req, res, pathname) => {
  const safe = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''); const file = path.resolve(publicDir, safe);
  if (!file.startsWith(path.resolve(publicDir))) return bad(res, 403, '禁止访问');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return text(res, 404, 'Not found');
  const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
  const sharePageUrl = publicBaseUrl ? `${publicBaseUrl}/` : `${appBasePath || ''}/`;
  const shareImageUrl = publicBaseUrl ? `${publicBaseUrl}/anqiao-logo.png` : `${appBasePath || ''}/anqiao-logo.png`;
  const body = file.endsWith('.html') ? fs.readFileSync(file, 'utf8').replaceAll('__APP_BASE_PATH__', appBasePath).replaceAll('__SHARE_PAGE_URL__', sharePageUrl).replaceAll('__SHARE_IMAGE_URL__', shareImageUrl) : fs.readFileSync(file);
  text(res, 200, body, type);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, version: appVersion, authMode, name: '桉侨集团财务报表看板' });
    if (url.pathname === '/auth/wecom') {
      if (authMode !== 'wecom') return redirect(res, appPath('/'));
      return redirect(res, wecomLoginUrl());
    }
    if (url.pathname === '/auth/wecom/callback') {
      if (authMode !== 'wecom') return redirect(res, appPath('/'));
      const code = url.searchParams.get('code'); const state = verifyPayload(url.searchParams.get('state'), 'oauth');
      if (!code || !state) return bad(res, 400, '企业微信登录参数无效或已过期，请重新进入应用');
      const token = await wecomAccessToken(); const identity = await wecomJson(wecomApiUrl('/cgi-bin/user/getuserinfo', { access_token: token, code }));
      if (!identity.UserId) return bad(res, 403, '当前身份不是应用可见范围内的企业成员');
      const employee = await syncWecomEmployee(identity.UserId); log(employee.employee_key, 'wecom_login', employee.employee_key, '企业微信 OAuth 登录');
      return redirect(res, appPath('/'), { 'set-cookie': sessionCookie(employee.employee_key) });
    }
    if (url.pathname === '/auth/logout') return redirect(res, authMode === 'wecom' ? appPath('/auth/wecom') : appPath('/'), { 'set-cookie': clearSessionCookie() });
    if (!url.pathname.startsWith('/api/')) {
      if (authMode === 'wecom' && !employeeFrom(req)) return redirect(res, appPath('/auth/wecom'));
      return sendStatic(req, res, url.pathname);
    }
    if (url.pathname === '/api/wecom/js-sdk-config' && req.method === 'GET') {
      const employee = requireEmployee(req, res); if (!employee) return;
      if (authMode !== 'wecom') return json(res, 200, { enabled: false, authMode });
      let pageUrl;
      try { pageUrl = normalizeSharePageUrl(url.searchParams.get('url')); }
      catch { return bad(res, 400, '分享页面地址无效'); }
      const timestamp = Math.floor(Date.now() / 1000); const nonceStr = crypto.randomBytes(16).toString('hex');
      const [corpTicket, agentTicket] = await Promise.all([wecomJsApiTicket('corp'), wecomJsApiTicket('agent_config')]);
      return json(res, 200, {
        enabled: true,
        corpId: wecomConfig.corpId,
        agentId: wecomConfig.agentId,
        timestamp,
        nonceStr,
        signature: wecomJsSdkSignature(corpTicket, nonceStr, timestamp, pageUrl),
        agentSignature: wecomJsSdkSignature(agentTicket, nonceStr, timestamp, pageUrl)
      });
    }
    if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
      const employee = requireEmployee(req, res); if (!employee) return;
      if (authMode === 'wecom' && /^企微部门\s+\d+$/.test(employee.department)) {
        try { Object.assign(employee, await syncWecomEmployee(employee.employee_key)); } catch {}
      }
      const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06';
      const roleNames = rolesFor(employee.employee_key).map(r => r.role_name);
      const reportTypes = db.prepare('SELECT report_type AS key, report_name AS name FROM report_types ORDER BY rowid').all();
      const canViewDetails = hasModule(employee.employee_key, 'report_detail', 'view');
      const reportDetailAccess = Object.fromEntries(reportTypes.map(item => [item.key, canViewDetails && hasReport(employee.employee_key, item.key, 'detail', 'view', companyKey, period)]));
      const consolidatedEntitiesByReport = Object.fromEntries([...groupStatementReportTypes].map(type => [type, consolidatedEntitiesFor(type, companyKey, period, employee.employee_key)]));
      return json(res, 200, { authMode, employee: { key: employee.employee_key, name: employee.display_name, department: employee.department }, roles: roleNames, reportWatermarkEnabled: reportWatermarkEnabled(), reportDetailAccess, canManagePermissions: hasModule(employee.employee_key, 'permission_admin', 'manage'), canManageReportData: hasModule(employee.employee_key, 'database_admin', 'view'), canCreateCompanies: hasModule(employee.employee_key, 'permission_admin', 'manage') && permissionProfileFor(employee.employee_key).companyKeys.includes('*'), canReorderCompanies: hasModule(employee.employee_key, 'permission_admin', 'manage') && permissionProfileFor(employee.employee_key).companyKeys.includes('*'), canUploadReports: hasModule(employee.employee_key, 'report_import', 'upload'), canPublishReports: hasModule(employee.employee_key, 'report_import', 'publish'), availablePeriodsByCompany: availablePeriodsByCompanyFor(employee.employee_key), employees: authMode === 'demo' ? db.prepare('SELECT employee_key AS key, display_name AS name, department FROM employees WHERE active = 1 ORDER BY employee_key').all() : [{ key: employee.employee_key, name: employee.display_name, department: employee.department }], companies: authorizedCompaniesFor(employee.employee_key), reportTypes, modules: visibleModulesFor(employee.employee_key, companyKey, period), consolidatedEntities: consolidatedEntitiesByReport.consolidated_income_statement, consolidatedEntitiesByReport, moduleOrder: moduleOrderFor(), analysisBlockOrder: allAnalysisBlockOrders() });
    }
    if (url.pathname === '/api/admin/report-watermark' && req.method === 'POST') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '没有权限修改员工水印设置'); return; }
      const body = await parseBody(req);
      if (typeof body.enabled !== 'boolean') return bad(res, 400, '员工水印开关必须是布尔值');
      saveAppSetting('report_watermark_enabled', body.enabled ? '1' : '0', employee.employee_key);
      log(employee.employee_key, 'set_report_watermark', 'app_settings', `enabled=${body.enabled}`);
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
      log(employee.employee_key, 'create_company', companyKey, name);
      return json(res, 201, { company: { key: companyKey, name } });
    }
    if (url.pathname === '/api/uploads' && req.method === 'GET') {
      const employee = requireImport(req, res, 'upload'); if (!employee) return;
      const companyKey = url.searchParams.get('company') || ''; const period = url.searchParams.get('period') || '';
      let query = 'SELECT upload_key AS uploadKey, employee_key AS employeeKey, company_key AS companyKey, period, report_type AS reportType, file_name AS fileName, file_type AS fileType, content_hash AS contentHash, status, validation_message AS validationMessage, created_at AS createdAt, published_at AS publishedAt, notes FROM upload_batches WHERE 1=1'; const args = [];
      if (companyKey) { query += ' AND company_key = ?'; args.push(companyKey); } if (period) { query += ' AND period = ?'; args.push(period); }
      query += ' ORDER BY created_at DESC'; const uploads = db.prepare(query).all(...args).map(item => ({ ...item, canDelete: canDeleteUpload(employee.employee_key, item) })); return json(res, 200, { uploads });
    }
    if (url.pathname === '/api/uploads' && req.method === 'POST') {
      const employee = requireImport(req, res, 'upload'); if (!employee) return;
      const body = await parseBody(req); const { companyKey, period, reportType = '', fileName, fileType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64, notes = '' } = body;
      if (!companyRow(companyKey) || (reportType && !reportTypeRow(reportType)) || !/^\d{4}-\d{2}$/.test(String(period || '')) || !fileName || !contentBase64) return bad(res, 400, '公司、期间和文件均为必填；如为单报表上传可指定报表类型');
      const buffer = Buffer.from(String(contentBase64).replace(/^data:[^;]+;base64,/, ''), 'base64'); if (!buffer.length) return bad(res, 400, '文件内容为空');
      const bundleKey = `upl-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`; const safeName = path.basename(String(fileName)).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_'); const storagePath = path.join(uploadsDir, `${bundleKey}-${safeName}`); const rawPath = path.join(uploadsDir, `${bundleKey}.json`);
      let reports; try { reports = parseUploadedFile(buffer, safeName, fileType); } catch (error) { return bad(res, 400, `文件解析失败：${error.message}`); }
      const companyHint = uploadCompanyHint(safeName, reports);
      if (companyHint.conflict) return json(res, 409, { error: '文件名或报表内容中检测到多个公司地区，请核对原始文件后再上传', code: 'COMPANY_HINT_CONFLICT', selectedCompanyKey: companyKey, detectedCompanies: companyHint.matches, evidence: companyHint.sources });
      if (companyHint.detectedCompanyKey && companyHint.detectedCompanyKey !== companyKey) return json(res, 409, { error: `检测到文件地区为 ${companyHint.detectedCompanyName}，与当前选择 ${companyRow(companyKey).company_name} 不一致`, code: 'COMPANY_MISMATCH', selectedCompanyKey: companyKey, selectedCompanyName: companyRow(companyKey).company_name, detectedCompanyKey: companyHint.detectedCompanyKey, detectedCompanyName: companyHint.detectedCompanyName, evidence: companyHint.sources });
      const periodHint = uploadPeriodHint(safeName, reports, period);
      if (periodHint.conflict) return json(res, 409, { error: '文件名或工作表中检测到多个不一致的月份，请核对原始文件后再上传', code: 'PERIOD_HINT_CONFLICT', selectedPeriod: period, detectedPeriods: periodHint.explicitPeriods, detectedMonths: periodHint.monthHints, evidence: periodHint.sources });
      if (periodHint.detectedPeriod && periodHint.detectedPeriod !== period) return json(res, 409, { error: `检测到文件期间为 ${periodHint.detectedPeriod}，与当前选定期间 ${period} 不一致`, code: 'PERIOD_MISMATCH', selectedPeriod: period, detectedPeriod: periodHint.detectedPeriod, evidence: periodHint.sources });
      const recognizedTypes = Object.keys(reports).filter(type => reportTypeRow(type)); const selectedTypes = recognizedTypes.length > 1 || !reportType ? recognizedTypes : recognizedTypes.filter(type => type === reportType);
      if (!selectedTypes.length) return bad(res, 400, reportType ? '文件中没有找到指定报表工作表' : '文件中没有找到可识别的报表工作表');
      if (selectedTypes.some(type => groupOnlyReportTypes.has(type)) && companyKey !== 'group') return json(res, 409, { error: '集团报表只能归属“桉侨集团”，请切换上传公司后重试', code: 'GROUP_COMPANY_REQUIRED', selectedCompanyKey: companyKey, requiredCompanyKey: 'group' });
      if (companyKey === 'group' && selectedTypes.some(type => !groupOnlyReportTypes.has(type))) return json(res, 409, { error: '“桉侨集团”只接收集团合并利润表和营收统计表，请重新选择报表或公司', code: 'GROUP_REPORT_TYPE_REQUIRED' });
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
        db.prepare("UPDATE upload_batches SET status = 'validated' WHERE upload_key = ?").run(uploadKey); log(employee.employee_key, 'upload_report', uploadKey, `${companyKey}/${period}/${type}/${fileName}`);
        createdUploads.push({ uploadKey, reportType: type, status: 'validated' });
      }
      return json(res, 201, { uploadKey: createdUploads[0].uploadKey, uploadKeys: createdUploads.map(item => item.uploadKey), status: 'validated', uploads: createdUploads, trimmedSheets, sheets: Object.entries(reports).map(([key, value]) => ({ reportType: key, sourceSheet: value.sourceSheet, rows: value.maxRow, columns: value.maxCol, hidden: Boolean(value.hidden), declaredRange: value.declaredRange || '', effectiveRange: value.effectiveRange || '', trimmed: Boolean(value.rangeTrimmed) })) });
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
      for (const { upload } of prepared) log(employee.employee_key, 'publish_upload', upload.upload_key, `${upload.company_key}/${upload.period}/${upload.report_type}/bulk`);
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
              log(employee.employee_key, 'restore_previous_upload', previousUploadKey, `${item.company_key}/${item.period}/${item.report_type}/v${previous.version}`);
            }
            log(employee.employee_key, 'withdraw_published_upload', item.upload_key, `${item.company_key}/${item.period}/${item.report_type}/${item.file_name}`);
          } else log(employee.employee_key, 'delete_unpublished_upload', item.upload_key, `${item.company_key}/${item.period}/${item.report_type}/${item.file_name}`);
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
      if (action === 'validate') { db.prepare("UPDATE upload_batches SET status = 'validated', validation_message = '校验通过' WHERE upload_key = ? AND status IN ('parsed', 'validated')").run(uploadKey); log(employee.employee_key, 'validate_upload', uploadKey, '校验通过'); return json(res, 200, { ok: true, status: 'validated' }); }
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
      db.prepare("UPDATE upload_batches SET status = 'published', published_at = ? WHERE upload_key = ?").run(now(), uploadKey); log(employee.employee_key, 'publish_upload', uploadKey, `${upload.company_key}/${upload.period}/${upload.report_type}`); return json(res, 200, { ok: true, status: 'published', version: snapshot.version });
    }
    const rawMatch = url.pathname.match(/^\/api\/reports\/([^/]+)\/raw$/);
    if (rawMatch && req.method === 'GET') {
      const reportType = rawMatch[1]; const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06'; if (!reportTypeRow(reportType) || !companyRow(companyKey)) return bad(res, 404, '报表或公司不存在');
      const employee = requireReport(req, res, reportType, 'summary', 'view', companyKey, period); if (!employee) return;
      const upload = url.searchParams.get('uploadKey') ? db.prepare('SELECT * FROM upload_batches WHERE upload_key = ? AND company_key = ? AND period = ? AND report_type = ?').get(url.searchParams.get('uploadKey'), companyKey, period, reportType) : db.prepare("SELECT * FROM upload_batches WHERE company_key = ? AND period = ? AND report_type = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1").get(companyKey, period, reportType);
      let raw; let meta;
      if (upload && fs.existsSync(upload.raw_path)) { const all = JSON.parse(fs.readFileSync(upload.raw_path, 'utf8')); raw = all[reportType] || all; meta = { demo: false, uploadKey: upload.upload_key, fileName: upload.file_name, uploadedBy: upload.employee_key, status: upload.status, createdAt: upload.created_at, publishedAt: upload.published_at }; }
      else { const missing = rawReportFor(reportType, companyKey, period); raw = missing.raw; meta = { ...missing.meta, uploadedBy: null }; }
      log(employee.employee_key, 'view_raw_report', `${reportType}:raw`, `${companyKey}/${period}`); return json(res, 200, { report: reportType, company: companyRow(companyKey).company_name, period, meta, raw });
    }
    if (url.pathname === '/api/analysis/financial-brief' && req.method === 'GET') {
      const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06';
      if (!companyRow(companyKey)) return bad(res, 404, '公司不存在');
      const employee = requireEmployee(req, res); if (!employee) return;
      if (!hasAnalysis(employee.employee_key, financialBriefModuleKey, companyKey, period)) return bad(res, 403, '当前员工没有财务数据简报权限');
      const brief = financialBriefFor(companyKey, period); log(employee.employee_key, 'view_financial_brief', financialBriefModuleKey, `${companyKey}/${period}`);
      return json(res, 200, brief);
    }
    if (url.pathname === '/api/analysis/group-profit-trends' && req.method === 'GET') {
      const companyKey = url.searchParams.get('company') || 'group'; const period = url.searchParams.get('period') || '2026-07'; const year = url.searchParams.get('year') || period.slice(0, 4);
      if (companyKey !== 'group') return bad(res, 400, '集团合并利润趋势图仅适用于桉侨集团');
      const employee = requireEmployee(req, res); if (!employee) return;
      if (!hasAnalysis(employee.employee_key, 'group_profit_analysis', companyKey, period) || !hasReport(employee.employee_key, 'consolidated_income_statement', 'summary', 'view', companyKey, period)) { bad(res, 403, '当前员工没有集团合并利润趋势图权限'); return; }
      const analysis = groupProfitAnalysisFor(period, year); log(employee.employee_key, 'view_group_profit_analysis', 'group_profit_analysis', `${companyKey}/${period}`);
      return json(res, 200, { company: companyRow(companyKey).company_name, period, ...analysis });
    }
    if (url.pathname === '/api/analysis/cash-flow' && req.method === 'GET') {
      const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06'; const year = url.searchParams.get('year') || period.slice(0, 4);
      if (!companyRow(companyKey)) return bad(res, 404, '公司不存在');
      const employee = requireEmployee(req, res); if (!employee) return;
      if (!hasAnalysis(employee.employee_key, 'cash_analysis', companyKey, period)) { bad(res, 403, '当前员工没有资产净额分析权限'); return; }
      const analysis = cashFlowAnalysisFor(companyKey, period, year); log(employee.employee_key, 'view_cash_flow_analysis', 'cash_flow_analysis', `${companyKey}/${period}`);
      return json(res, 200, { company: companyRow(companyKey).company_name, period, ...analysis });
    }
    if (url.pathname === '/api/analysis/main-business' && req.method === 'GET') {
      const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06'; const year = url.searchParams.get('year') || period.slice(0, 4);
      if (!companyRow(companyKey)) return bad(res, 404, '公司不存在');
      const employee = requireEmployee(req, res); if (!employee) return;
      if (!hasAnalysis(employee.employee_key, 'main_business_analysis', companyKey, period)) { bad(res, 403, '当前员工没有主营业务分析权限'); return; }
      const analysis = mainBusinessAnalysisFor(companyKey, period, year); log(employee.employee_key, 'view_main_business_analysis', 'main_business_analysis', `${companyKey}/${period}`);
      return json(res, 200, analysis);
    }
    if (url.pathname === '/api/analysis/expenses' && req.method === 'GET') {
      const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06'; const year = url.searchParams.get('year') || period.slice(0, 4);
      if (!companyRow(companyKey)) return bad(res, 404, '公司不存在');
      const employee = requireEmployee(req, res); if (!employee) return;
      if (!hasAnalysis(employee.employee_key, 'expense_analysis', companyKey, period)) { bad(res, 403, '当前员工没有费用分析权限'); return; }
      const analysis = expenseAnalysisFor(companyKey, period, year); log(employee.employee_key, 'view_expense_analysis', 'expense_analysis', `${companyKey}/${period}`);
      return json(res, 200, analysis);
    }
    const reportMatch = url.pathname.match(/^\/api\/reports\/([^/]+)\/(summary|detail|versions|export)$/);
    if (reportMatch) {
      const [, reportType, operation] = reportMatch; const companyKey = url.searchParams.get('company') || 'gz'; const period = url.searchParams.get('period') || '2026-06'; const lineCode = url.searchParams.get('line') || ''; const search = url.searchParams.get('search') || ''; const accountCodes = [...new Set(String(url.searchParams.get('accountCodes') || '').split(',').map(value => value.trim()).filter(Boolean))].slice(0, 20);
      if (!reportTypeRow(reportType) || !companyRow(companyKey)) return bad(res, 404, '报表或公司不存在');
      const level = operation === 'summary' || operation === 'versions' ? 'summary' : operation === 'export' ? (url.searchParams.get('level') || 'detail') : 'detail'; const action = operation === 'export' ? 'export' : 'view'; const employee = requireReport(req, res, reportType, level, action, companyKey, period); if (!employee) return;
      if (operation === 'versions') return json(res, 200, { versions: db.prepare("SELECT version, status, source_name AS source, notes, created_at AS createdAt FROM report_snapshots WHERE company_key = ? AND period = ? AND report_type = ? AND snapshot_key LIKE '%-upload-%' ORDER BY version DESC").all(companyKey, period, reportType) });
      const snapshot = snapshotFor(companyKey, period, reportType, url.searchParams.get('version')); if (!snapshot) {
        if (operation === 'detail' && search) { const preference = detailPreferenceFor(employee.employee_key); const sourceDetail = sourceDetailFor(reportType, companyKey, period, search, employee.employee_key, preference.showFullEntry, accountCodes); return json(res, 200, { report: reportType, company: companyRow(companyKey).company_name, period, line: lineCode || null, search, accountCodes, snapshot: null, rows: [], ...sourceDetail, accountVisibility: accountVisibilityFor(employee.employee_key), showDirection: preference.showDirection, showFullEntry: preference.showFullEntry }); }
        return bad(res, 404, '该期间没有已保存的报表版本');
      }
      log(employee.employee_key, action === 'export' ? 'export_report' : 'view_report', `${reportType}:${level}`, `${companyKey}/${period}/v${snapshot.version}`);
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
      if (!wecomDirectorySyncEnabled) return json(res, 409, { error: '企业微信通讯录同步尚未授权启用', sync: directorySyncState() });
      const sync = await syncWecomDirectorySafely({ force: true });
      if (sync.status === 'failed') return json(res, 502, { error: sync.lastError || '企业微信通讯录同步失败', sync });
      return json(res, 200, { ok: true, sync });
    }
    if (url.pathname === '/api/admin/directory-employees' && req.method === 'GET') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '没有权限查看通讯录'); return; }
      const sync = await syncWecomDirectorySafely();
      const search = String(url.searchParams.get('search') || '').trim(); const like = `%${search}%`;
      const sourceClause = authMode === 'wecom' ? " AND directory_source = 'wecom'" : '';
      const employees = db.prepare(`SELECT employee_key AS employeeKey, display_name AS name, department FROM employees WHERE active = 1${sourceClause} AND (? = '' OR display_name LIKE ? OR department LIKE ?) ORDER BY display_name LIMIT 50`).all(search, like, like).map(item => ({ ...item, source: authMode === 'wecom' ? '企微通讯录' : '本地演示通讯录' }));
      return json(res, 200, { employees, source: authMode === 'wecom' ? 'wecom' : 'demo', sync });
    }
    if (url.pathname === '/api/admin/roles' && req.method === 'GET') {
      const employee = requireEmployee(req, res); if (!employee || !hasModule(employee.employee_key, 'permission_admin', 'manage')) { if (employee) bad(res, 403, '没有权限管理授权'); return; }
      const directorySync = await syncWecomDirectorySafely();
      const roles = db.prepare('SELECT role_key AS key, role_name AS name, description FROM roles ORDER BY role_key').all();
      const assignments = db.prepare('SELECT er.employee_key AS employeeKey, e.display_name AS employeeName, er.role_key AS roleKey, r.role_name AS roleName FROM employee_roles er JOIN employees e ON e.employee_key = er.employee_key JOIN roles r ON r.role_key = er.role_key ORDER BY e.display_name').all();
      const scopes = db.prepare('SELECT role_key AS roleKey, report_type AS reportType, access_level AS level, action, company_key AS companyKey, from_period AS fromPeriod, to_period AS toPeriod FROM role_report_scopes ORDER BY role_key, report_type, access_level, action').all();
      const accountVisibility = db.prepare('SELECT role_key AS roleKey, visibility FROM role_account_visibility ORDER BY role_key').all();
      const detailPreferences = db.prepare('SELECT role_key AS roleKey, show_direction AS showDirection, show_full_entry AS showFullEntry FROM role_detail_preferences ORDER BY role_key').all().map(item => ({ ...item, showDirection: Number(item.showDirection) === 1, showFullEntry: Number(item.showFullEntry) === 1 }));
      const employees = db.prepare(`SELECT employee_key AS employeeKey, display_name AS name, department FROM employees WHERE active = 1${authMode === 'wecom' ? " AND directory_source = 'wecom'" : ''} ORDER BY display_name`).all();
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
      if (!companyKeys.length || companyKeys.some(key => key !== '*' && !db.prepare('SELECT 1 FROM companies WHERE company_key = ?').get(key))) return bad(res, 400, '请选择有效的公司范围');
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
server.listen(port, '127.0.0.1', () => console.log(`桉侨集团财务报表看板 v${appVersion} (${authMode}) listening on http://127.0.0.1:${port}`));

export { db, server, hasReport };
