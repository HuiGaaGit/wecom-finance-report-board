import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

let TestDatabase;
try {
  ({ default: TestDatabase } = await import('better-sqlite3'));
  const probe = new TestDatabase(':memory:'); probe.close();
} catch {
  ({ default: TestDatabase } = await import('../14云端企微账簿/node_modules/better-sqlite3/lib/index.js'));
}

const testPort = 30000 + (process.pid % 20000);
const base = `http://127.0.0.1:${testPort}`;
const projectDir = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(projectDir, 'data', `test-report-board-${process.pid}-${Date.now()}.db`);
const testUploadsDir = path.join(projectDir, 'data', `test-uploads-${process.pid}-${Date.now()}`);
const testConsultantDirectoryFile = path.join(projectDir, 'data', `test-consultant-directory-${process.pid}-${Date.now()}.json`);
const testConsultantDirectoryStatusFile = path.join(projectDir, 'data', `test-consultant-directory-status-${process.pid}-${Date.now()}.json`);
const testConsultantDirectoryRefreshRequestFile = path.join(projectDir, 'data', `test-consultant-directory-refresh-${process.pid}-${Date.now()}.json`);
const testConsultantDirectoryAuthRequestFile = path.join(projectDir, 'data', `test-consultant-directory-auth-${process.pid}-${Date.now()}.json`);
let child;

const { exactTwoColumnRows, preservedAuthLink } = await import('./deploy/sync-consultant-directory.mjs');
const { safeAuthUrl } = await import('./deploy/init-consultant-directory-auth.mjs');

test('企微花名册只接受结构化精确两列，授权链接严格限定官方临时入口', () => {
  const rows = exactTwoColumnRows({ grid_data: { rows: [
    { values: [] },
    { values: [{ cell_value: { text: '姓名' }, data_type: 'TEXT' }, { cell_value: { text: '英文名' }, data_type: 'TEXT' }] },
    { values: [{ cell_value: { text: '测试顾问' }, data_type: 'TEXT' }, { cell_value: { text: 'Tester' }, data_type: 'TEXT' }, { cell_value: { text: '' }, data_type: 'TEXT' }] }
  ] } });
  assert.deepEqual(rows, [['', ''], ['姓名', '英文名'], ['测试顾问', 'Tester']]);
  assert.throws(() => exactTwoColumnRows({ grid_data: { rows: [{ values: [{ cell_value: { text: '甲' } }, { cell_value: { text: 'A' } }, { cell_value: { text: '手机号' } }] }] } }), /超出姓名\/英文名允许列/);
  const valid = 'https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=Abc_123-def';
  assert.equal(safeAuthUrl(valid), valid);
  assert.equal(safeAuthUrl('https://example.com/ai/qc/gen?source=wecom_cli_external&scode=Abc_123-def'), '');
  assert.equal(safeAuthUrl('https://work.weixin.qq.com/ai/qc/gen?source=other&scode=Abc_123-def'), '');
  const authUrlExpiresAt = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(preservedAuthLink({ authUrl: valid, authUrlExpiresAt }), { authUrl: valid, authUrlExpiresAt });
  assert.deepEqual(preservedAuthLink({ authUrl: valid, authUrlExpiresAt: '2020-01-01T00:00:00.000Z' }), {});
});

async function request(pathname, employee = 'admin') {
  const response = await fetch(`${base}${pathname}`, { headers: { 'x-demo-employee': employee } });
  const payload = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
  return { response, payload };
}
async function post(pathname, body, employee = 'admin') {
  const response = await fetch(`${base}${pathname}`, { method: 'POST', headers: { 'x-demo-employee': employee, 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body) });
  const payload = await response.json(); return { response, payload };
}
async function put(pathname, body, employee = 'admin') {
  const response = await fetch(`${base}${pathname}`, { method: 'PUT', headers: { 'x-demo-employee': employee, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json(); return { response, payload };
}
async function remove(pathname, body, employee = 'admin') {
  const response = await fetch(`${base}${pathname}`, { method: 'DELETE', headers: { 'x-demo-employee': employee, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json(); return { response, payload };
}

const demoReports = JSON.parse(fs.readFileSync(path.join(projectDir, 'data', 'raw-reports-demo.json'), 'utf8'));
async function publishFixture(companyKey, period, reportTypes) {
  const reports = Object.fromEntries(reportTypes.map(reportType => [reportType, demoReports[reportType]]));
  const uploaded = await post('/api/uploads', {
    companyKey, period, reportType: reportTypes.length === 1 ? reportTypes[0] : '',
    fileName: `${companyKey}-${period}-explicit-test-fixture.json`, fileType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify(reports)).toString('base64')
  });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  const batches = uploaded.payload.uploads || [uploaded.payload];
  for (const batch of batches) assert.equal((await post(`/api/uploads/${batch.uploadKey}/publish`, {})).response.status, 200);
}

function quotationLedgerWorkbookBuffer(records = []) {
  const workbook = XLSX.utils.book_new();
  const rows = [
    [null, null, null, null, null, null, null, null, null, null, 0],
    ['序号', '合同类型', '合同编号', '报价日期', '项目负责人', '项目', '来源（一级）', '来源（二级）', '签约顾问', '客户姓名', '合同金额\n【应收金额】'],
    ...records.map((item, index) => [index + 1, '国内销售', item.contractNo, '2026-07-01', '测试顾问', item.projectName, '', '', '', item.customerName, 10000])
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '报价单');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

async function publishIntercompanyCompany(company, region, period, items) {
  const trialRows = [
    { row: 1, cells: ['科目余额表'] }, { row: 2, cells: [`编制单位：${company.name}`, null, null, null, `${period.slice(0, 4)}年${Number(period.slice(5))}月`] },
    { row: 3, cells: ['科目编码', '科目名称', '期初余额', null, '本期发生额', null, '本年累计发生额', null, '期末余额', null] }, { row: 4, cells: [null, null, '借方', '贷方', '借方', '贷方', '借方', '贷方', '借方', '贷方'] },
    ...items.map((item, index) => ({ row: index + 5, cells: [item.code, item.name, 0, 0, item.debit, item.credit, item.debit, item.credit, item.debit, item.credit] }))
  ];
  const journalRows = [{ row: 1, cells: ['日期', '凭证号', '摘要', '科目编码', '科目名称', '借方金额', '贷方金额'] }, ...items.map((item, index) => ({ row: index + 2, cells: [`${period}-08`, `记-${region}-${index + 1}`, `${region}往来测试`, item.code, item.name, item.debit, item.credit] }))];
  const month = Number(period.slice(5));
  const reports = { trial_balance: { sourceSheet: `${month}月科目余额表`, rows: trialRows, maxRow: trialRows.length, maxCol: 10 }, journal: { sourceSheet: `${month}月序时账`, rows: journalRows, maxRow: journalRows.length, maxCol: 7 } };
  const uploaded = await post('/api/uploads', { companyKey: company.key, period, fileName: `${period}-${company.name}-往来校验.json`, fileType: 'application/json', contentBase64: Buffer.from(JSON.stringify(reports)).toString('base64') });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  for (const batch of uploaded.payload.uploads) assert.equal((await post(`/api/uploads/${batch.uploadKey}/publish`, {})).response.status, 200);
}

async function publishIntercompanyFixture(period = '2027-04') {
  const wanted = [['广州', '广州桉侨'], ['深圳', '深圳桉侨'], ['成都', '成都桉侨出国咨询服务有限公司'], ['南京', '南京桉侨'], ['长沙', '长沙桉侨海外咨询服务有限公司'], ['青岛', '青岛桉侨'], ['北京', '北京侨桉咨询服务有限公司']];
  const bootstrap = (await request(`/api/bootstrap?company=group&period=${period}`)).payload; const companies = new Map();
  for (const [region, name] of wanted) {
    let company = bootstrap.companies.find(item => item.name.includes(region));
    if (!company) { const created = await post('/api/admin/companies', { name }); assert.equal(created.response.status, 201); company = created.payload.company; }
    companies.set(region, company);
  }
  const entry = (code, name, debit, credit) => ({ code, name, debit, credit });
  const balances = {
    广州: [entry('1122001', '深圳市桉侨移民咨询服务有限公司', 100, 0), entry('1221004', '成都桉侨出国咨询服务有限公司', 50, 0), entry('1122005', '南京桉侨移民服务有限公司', 30, 0), entry('1122006', '长沙桉侨海外咨询服务有限公司', 70, 0), entry('1122007', '青岛桉侨移民服务有限公司', 20, 0), entry('1221008', '北京侨桉咨询服务有限公司办公室押金', 10, 0)],
    深圳: [entry('2202001', '广州桉侨移民咨询服务有限公司', 0, 100)], 成都: [], 南京: [entry('1122001', '广州桉侨移民咨询服务有限公司', 30, 0)],
    长沙: [entry('2202001', '广州桉侨移民咨询服务有限公司', 0, 60)], 青岛: [entry('2202001', '广州桉侨移民咨询服务有限公司', 20, 0)], 北京: []
  };
  for (const [region, company] of companies) {
    await publishIntercompanyCompany(company, region, period, balances[region]);
  }
  return companies;
}

function consolidatedWorkbookBuffer() {
  const labels = Array.from({ length: 32 }, (_, index) => `项目${index + 1}`);
  labels[0] = '一、营业收入'; labels[1] = '减：营业成本'; labels[10] = '销售费用'; labels[13] = '管理费用'; labels[17] = '财务费用'; labels[20] = '二、营业利润（亏损以“-”号填列）'; labels[29] = '三、利润总额（亏损总额以“-”号填列）'; labels[30] = '减：所得税费用'; labels[31] = '四、净利润（净亏损以“-”号填列）';
  const rowsFor = (title, company, annualValues, currentValues, reportDate = '2026年7月') => [
    [null, title, null, null, null],
    [null, '会小企02表', null, null, null],
    [null, `编制单位：${company}`, reportDate, null, '单位：元'],
    [null, '项目', '行次', '本年累计金额', '本期金额'],
    ...labels.map((label, index) => [null, label, index + 1, annualValues[index] || 0, currentValues[index] || 0])
  ];
  const annualA = Array(32).fill(0); const currentA = Array(32).fill(0); const annualB = Array(32).fill(0); const currentB = Array(32).fill(0);
  Object.assign(annualA, { 0: 600, 1: 300, 10: 60, 13: 30, 17: 12, 20: 300, 29: 300, 31: 300 }); Object.assign(currentA, { 0: 60, 1: 30, 10: 10, 13: 5, 17: 2, 20: 30, 29: 30, 31: 30 });
  Object.assign(annualB, { 0: 400, 1: 200, 10: 40, 13: 20, 17: 8, 20: 200, 29: 200, 31: 200 }); Object.assign(currentB, { 0: 40, 1: 20, 10: 8, 13: 4, 17: 1, 20: 20, 29: 20, 31: 20 });
  const annualGroup = annualA.map((value, index) => value + annualB[index]); const currentGroup = currentA.map((value, index) => value + currentB[index]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rowsFor('桉侨集团合并利润表', '桉侨集团', annualGroup, currentGroup, 46204)), '集团利润表');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rowsFor('利润表', '广州桉侨有限公司', annualA, currentA)), '广州桉侨');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rowsFor('利润表', '深圳桉侨移民服务有限公司', annualB, currentB)), '深圳桉侨');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function revenueProfitWorkbookBuffer() {
  const labels = Array.from({ length: 32 }, (_, index) => `项目${index + 1}`);
  labels[0] = '一、营业收入'; labels[1] = '减：营业成本'; labels[10] = '销售费用'; labels[13] = '管理费用'; labels[17] = '财务费用'; labels[20] = '二、营业利润（亏损以“-”号填列）'; labels[29] = '三、利润总额（亏损总额以“-”号填列）'; labels[30] = '减：所得税费用'; labels[31] = '四、净利润（净亏损以“-”号填列）';
  const rowsFor = (title, company, annualValues, currentValues, reportDate = '2026年7月', adjusted = false) => [
    [null, title, null, null, null, null, null, null],
    [null, '会小企02表', null, null, null, null, null, null],
    [null, `编制单位：${company}`, reportDate, null, '单位：元', null, null, null],
    [null, '项目', '行次', '本年累计金额', '本期金额', '当月调整数', '累计调整数', null],
    ...labels.map((label, index) => [null, label, index + 1, annualValues[index] || 0, currentValues[index] || 0, adjusted && index === 1 ? 35 : null, adjusted && index === 10 ? 120 : null, adjusted && index === 10 ? '补自有资源提成' : null]),
    [null, 'Row Labels', null, null, null, null, null, null],
    [null, '辅助项目', 999, 999, 999, 999, 999, '不得展示']
  ];
  const annualA = Array(32).fill(0); const currentA = Array(32).fill(0); const annualB = Array(32).fill(0); const currentB = Array(32).fill(0);
  Object.assign(annualA, { 0: 600, 1: 300, 10: 60, 13: 30, 17: 12, 20: 300, 29: 300, 31: 300 }); Object.assign(currentA, { 0: 60, 1: 30, 10: 10, 13: 5, 17: 2, 20: 30, 29: 30, 31: 30 });
  Object.assign(annualB, { 0: 400, 1: 200, 10: 40, 13: 20, 17: 8, 20: 200, 29: 200, 31: 200 }); Object.assign(currentB, { 0: 40, 1: 20, 10: 8, 13: 4, 17: 1, 20: 20, 29: 20, 31: 20 });
  const annualGroup = annualA.map((value, index) => value + annualB[index]); const currentGroup = currentA.map((value, index) => value + currentB[index]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rowsFor('桉侨集团合并利润表（营收利润口径）', '桉侨集团', annualGroup, currentGroup, 46204, true)), '营收口径集团利润表');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rowsFor('利润表（营收利润口径）', '广州桉侨', annualA, currentA)), '广州桉侨');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rowsFor('利润表（营收利润口径）', '深圳桉侨', annualB, currentB)), '深圳桉侨');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function revenueStatisticsWorkbookBuffer(period = '2026-07', legacyTitles = false) {
  const [year, monthText] = period.split('-');
  const month = Number(monthText);
  const anchors = [
    { key: 'B1', column: 0, title: `${year}年${month}月营收总表 B1`, headers: ['统计地区', '实收总额', '项目数量'], rows: [['桉侨集团', 4932629.50455, 239], ['广州桉侨', 1200000, 58]] },
    { key: 'B2', column: 4, title: `${year}年${month}月项目营收排行 B2`, headers: ['项目名称', '实收总额', '占比'], rows: [['澳洲项目', 980000, 0.1987]] },
    { key: 'B3', column: 8, title: `${year}年${month}月项目经理营收明细 B3`, headers: ['项目经理', '实收总额', '项目数量'], rows: [['王经理', 680000, 16]] },
    { key: 'B4', column: 12, title: `${year}年${month}月直客项目来源统计总表 B4`, headers: ['项目来源', '实收总额', '项目数量'], rows: [['自主开发', 560000, 12]] },
    { key: 'B5', column: 16, title: `${year}年${month}月直客营收排名 B5`, headers: ['顾问', '实收总额', '占比'], rows: [['李顾问', 420000, 0.0852]] },
    { key: 'B6', column: 20, title: `${year}年${month}月直客营收明细排名统计 B6`, headers: ['客户名称', '项目名称', '实收总额'], rows: [['测试客户', '加拿大项目', 360000]] },
    { key: 'B7', column: 24, title: `${year}年${month}月渠道营收排名 B7`, headers: ['渠道名称', '实收总额', '占比'], rows: [['渠道甲', 310000, 0.0628]] },
    { key: 'B8', column: 28, title: `${year}年${month}月渠道营收明细排名统计 B8`, headers: ['渠道名称', '客户名称', '实收总额'], rows: [['渠道甲', '渠道客户', 310000]] }
  ];
  const rows = Array.from({ length: 35 }, () => Array(60).fill(null));
  rows[0][0] = '本月集团维度数据统计'; rows[0][12] = '本月单独直客维度统计数据'; rows[0][24] = '本月单独渠道维度统计数据';
  for (const anchor of anchors) {
    rows[1][anchor.column] = legacyTitles ? anchor.title.replace(/\s+B[1-8]$/i, '') : anchor.title;
    anchor.headers.forEach((header, index) => { rows[2][anchor.column + index] = header; });
    anchor.rows.forEach((dataRow, rowIndex) => dataRow.forEach((value, columnIndex) => { rows[3 + rowIndex][anchor.column + columnIndex] = value; }));
  }
  rows[6][0] = '注：渠道单独统计数据与直客单独统计数据不可直接相加，当月实际营收以集团口径为准。';
  rows[10][0] = `${year}年累计数据`;
  const cumulativeAnchors = [
    { key: 'L1', column: 0, title: `${year}年总集团营收表（时间划分）L1`, headers: ['月份', '预计营收', '营收占比', '项目数量'], data: [[`${year}01`, 3531763.06, 0.4, 175], ['总计', 8831763.06, 1, 414]] },
    { key: 'L2', column: 5, title: `${year}年营收总表（区域划分）L2`, headers: ['业绩归属', '月份', '预计营收', '营收占比', '项目数量'], data: [['广州', null, 4200000, 0.48, 210], [null, `${year}01`, 1200000, 0.29, 58]] },
    { key: 'L2-1', column: 11, title: `${year}年营收项目明细表（区域划分）L2-1`, headers: ['业绩归属', '月份', '项目', '预计营收', '营收占比', '项目数量'], data: [['广州', `${year}01`, '澳洲项目', 980000, 0.23, 19]] },
    { key: 'L3', column: 18, title: `${year}年项目经理营收累计表L3`, headers: ['项目负责人', '月份', '预计营收', '营收占比', '项目数量'], data: [['Erin林小婷', `${year}01`, 680000, 0.08, 16]] },
    { key: 'L4', column: 27, title: `${year}年直客来源统计累计表（来源划分）L4`, headers: ['来源（一级）', '月份', '预计营收', '营收占比', '项目数量'], data: [['市场部新数据', `${year}01`, 560000, 0.12, 12]] },
    { key: 'L5', column: 40, title: `${year}年直客营收统计累计表（来源划分）L5`, headers: ['顾问', '来源（一级）', '预计营收', '营收占比', '项目数'], data: [['李顾问', '市场部新数据', 420000, 0.09, 8]] },
    { key: 'L6', column: 53, title: `${year}年渠道营收统计累计表L6`, headers: ['渠道顾问', '月份', '预计营收', '营收占比', '项目数量'], data: [['渠道甲', `${year}01`, 310000, 0.06, 6]] }
  ];
  for (const anchor of cumulativeAnchors) {
    rows[12][anchor.column] = anchor.title;
    anchor.headers.forEach((header, index) => { rows[13][anchor.column + index] = header; });
    anchor.data.forEach((dataRow, rowIndex) => dataRow.forEach((value, columnIndex) => { rows[14 + rowIndex][anchor.column + columnIndex] = value; }));
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '2026年数据统计汇总表（mia）');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['总营收明细表'],
    ['业绩归属', '签约顾问/渠道', '预计营收', '月份'],
    ['广州', 'James詹志坚', 100000, `${year}${monthText}`],
    ['深圳', 'sasa张莎莎', 80000, `${year}${monthText}`],
    ['广州', 'James詹志坚', 20000, `${year}${monthText}`],
    ['上海', 'Cici徐梓茵', 50000, `${year}${monthText}`],
    ['北京', '历史顾问', 999999, `${Number(year) - 1}12`]
  ]), '总营收明细表');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function payrollWorkbookBuffer() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['历史工资表'],
    ['序号', '中文姓名', '基本工资', '提成'],
    [1, '历史人员', 8000, 1000]
  ]), '202406月工资表');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['桉侨集团2027年3月工资表'],
    ['序号', '公司', '部门', '中文姓名', '入职日期', '底薪', '基本工资', '本月提成', '往期提成'],
    [1, '广州桉侨', '广州顾问部', '詹志坚', '2027年3月5日', 12000, 10000, 2000, 9000],
    [2, '深圳桉侨', '深圳顾问部', '张莎莎', '2026-02-01', 11000, 9000, 1500, 8000],
    [3, '桉侨集团', '财务部', '非顾问人员', '2026-02-01', 13000, 12000, 1800, 0],
    ['', '', '', '合计', '', '', 19000, 3500, 17000],
    ['', '', '', '当月计薪日', '', '', 24, '', ''],
    ['', '', '', 147, '', '', 13.5, '', '']
  ]), '202703工资表');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function consultantSpendWorkbookBuffer() {
  const workbook = XLSX.utils.book_new();
  const rows = [
    ['顾问', null, '付费', null, null, null, null, null, '自然流', null, '汇总', null, '7月营收', '顾问投产比'],
    [null, null, '小红书', '巨量', '百度', '谷歌', '腾讯', '渠道', '抖音', '公众号', '汇总/条', '总消耗/元'],
    ['广州', 'JAMES', 51, 16, 4, 1, 0, 5, 1, 0, 78, 26890.2, 60000, 2.23],
    [null, 'sasa', 41, 21, 3, 0, 0, 7, 0, 0, 72, 21617.63, 166900, 7.72],
    [null, '市场部分给渠道部', 15, 1, 2, 0, 0, 0, 0, 0, 18, 12000, 88067, 13.64],
    ['深圳', 'Unknown', 4, 6, 1, 0, 0, 0, 0, 0, 11, 9999, 0, 0],
    ['汇总', null, 111, 44, 10, 1, 0, 12, 1, 0, 179, 70489.83, 314967, 4.47]
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!merges'] = [XLSX.utils.decode_range('A1:B2'), XLSX.utils.decode_range('C1:H1'), XLSX.utils.decode_range('I1:J1'), XLSX.utils.decode_range('K1:L1')];
  XLSX.utils.book_append_sheet(workbook, sheet, '汇总');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['历史或辅助明细'], ['英文名', '总消耗/元'], ['JAMES', 999999]]), 'sheet2');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function legacyGroupWorkbookBuffer(reportType) {
  const buffer = reportType === 'consolidated_income_statement' ? consolidatedWorkbookBuffer() : revenueProfitWorkbookBuffer();
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sourceName = reportType === 'consolidated_income_statement' ? '集团利润表' : '营收口径集团利润表';
  workbook.Sheets['利润表'] = workbook.Sheets[sourceName];
  workbook.SheetNames[workbook.SheetNames.indexOf(sourceName)] = '利润表';
  delete workbook.Sheets[sourceName];
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function legacyGroupMainOnlyWorkbookBuffer() {
  const workbook = XLSX.read(legacyGroupWorkbookBuffer('consolidated_income_statement'), { type: 'buffer' });
  for (const name of workbook.SheetNames.filter(name => name !== '利润表')) delete workbook.Sheets[name];
  workbook.SheetNames = ['利润表'];
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function genericPayrollWorkbookBuffer() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['桉侨集团工资明细'],
    ['序号', '公司', '部门', '中文姓名', '入职日期', '基本工资', '本月提成'],
    [1, '广州桉侨', '广州顾问部', '测试顾问', '2027-06-02', 10000, 1200],
    ['', '', '', '合计', '', 10000, 1200]
  ]), 'Sheet1');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['部门', '人数', '工资合计'], ['顾问部', 1, 11200]
  ]), 'Sheet2');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function bundleWithStaleLedgerSourcesBuffer() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['利润表'], ['编制单位：广州桉侨', '2027年8月'], ['项目', '行次', '本年累计金额', '本期金额'], ['一、营业收入', 1, 80, 10], ['四、净利润', 2, 20, 3]
  ]), '利润表');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['科目余额表'], ['编制单位：广州桉侨', '2027年7月'], ['科目编码', '科目名称', '期末余额'], ['1001', '库存现金', 100]
  ]), '科目余额表');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '凭证号', '摘要', '科目编码', '科目名称', '借方金额', '贷方金额'],
    ['2027-07-31', '记-1', '上月分录', '6001', '主营业务收入', 0, 10]
  ]), '序时账');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

before(async () => {
  child = spawn(process.execPath, ['app.mjs'], { cwd: projectDir, env: { ...process.env, NODE_ENV: 'test', PORT: String(testPort), DB_FILE: testDbPath, UPLOADS_DIR: testUploadsDir, CONSULTANT_DIRECTORY_FILE: testConsultantDirectoryFile, CONSULTANT_DIRECTORY_STATUS_FILE: testConsultantDirectoryStatusFile, CONSULTANT_DIRECTORY_REFRESH_REQUEST_FILE: testConsultantDirectoryRefreshRequestFile, CONSULTANT_DIRECTORY_AUTH_REQUEST_FILE: testConsultantDirectoryAuthRequestFile }, stdio: 'ignore' });
  let started = false;
  for (let i = 0; i < 40; i++) {
    try { const response = await fetch(`${base}/api/health`); if (response.ok) { started = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!started) throw new Error('测试服务未启动');
  await publishFixture('gz', '2026-06', ['balance_sheet', 'income_statement', 'cash_flow', 'trial_balance', 'journal']);
  await publishFixture('sz', '2026-06', ['cash_flow']);
  await publishFixture('gz', '2026-07', ['journal']);
  await publishFixture('gz', '2026-08', ['journal']);
});

after(() => { child?.kill(); fs.rmSync(testUploadsDir, { recursive: true, force: true }); fs.rmSync(testConsultantDirectoryFile, { force: true }); fs.rmSync(testConsultantDirectoryStatusFile, { force: true }); fs.rmSync(testConsultantDirectoryRefreshRequestFile, { force: true }); fs.rmSync(testConsultantDirectoryAuthRequestFile, { force: true }); });

test('平台生产模式公开登录引导页并将未认证请求交给小Q登录', async () => {
  const authPort = testPort + 1; const authBase = `http://127.0.0.1:${authPort}`;
  const authDbPath = path.join(projectDir, 'data', `test-platform-auth-${process.pid}-${Date.now()}.db`);
  const authUploadsDir = path.join(projectDir, 'data', `test-platform-auth-uploads-${process.pid}-${Date.now()}`);
  const authChild = spawn(process.execPath, ['app.mjs'], { cwd: projectDir, env: {
    ...process.env, NODE_ENV: 'test', AUTH_MODE: 'platform', PORT: String(authPort), DB_FILE: authDbPath, UPLOADS_DIR: authUploadsDir,
    APP_BASE_PATH: '/report', PUBLIC_BASE_URL: 'https://qiandianxiaoq.com/report', SESSION_SECRET: 'test-session-secret-with-more-than-32-characters',
    PLATFORM_API_BASE_URL: 'http://127.0.0.1:9/api', PLATFORM_LOGIN_URL: '/platform/login', PLATFORM_API_BROWSER_BASE_PATH: '/api'
  }, stdio: 'ignore' });
  try {
    let started = false;
    for (let index = 0; index < 40; index++) { try { if ((await fetch(`${authBase}/api/health`)).ok) { started = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(started, true);
    const root = await fetch(`${authBase}/`, { redirect: 'manual' });
    assert.equal(root.status, 200); assert.match(await root.text(), /content="\/platform\/login"/);
    const protectedApi = await fetch(`${authBase}/api/bootstrap?company=gz&period=2026-06`, { headers: { 'x-demo-employee': 'admin' } });
    assert.equal(protectedApi.status, 401); assert.equal((await protectedApi.json()).loginUrl, '/platform/login');
    const legacyLogin = await fetch(`${authBase}/auth/wecom`, { redirect: 'manual' });
    assert.equal(legacyLogin.status, 302); assert.equal(legacyLogin.headers.get('location'), '/platform/login');
    const logout = await fetch(`${authBase}/auth/logout`, { redirect: 'manual' }); assert.equal(logout.headers.get('location'), '/platform/login');
    assert.match(logout.headers.get('set-cookie') || '', /Path=\/report(?:;|$)/);
    const authDb = new TestDatabase(authDbPath, { readonly: true });
    try {
      const importActions = authDb.prepare("SELECT action FROM role_permissions WHERE role_key = 'admin' AND module_key = 'report_import' ORDER BY action").all().map(row => row.action);
      assert.deepEqual(importActions, ['publish', 'upload', 'validate']);
    } finally { authDb.close(); }
  } finally {
    authChild.kill(); await new Promise(resolve => authChild.exitCode === null ? authChild.once('exit', resolve) : resolve());
    fs.rmSync(authUploadsDir, { recursive: true, force: true }); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${authDbPath}${suffix}`, { force: true });
  }
});

test('小Q令牌换取财务会话并动态校验成员组', async () => {
  const mockPort = testPort + 30; const appPort = testPort + 3; const appBase = `http://127.0.0.1:${appPort}`;
  const authDbPath = path.join(projectDir, 'data', `test-platform-directory-${process.pid}-${Date.now()}.db`);
  const authUploadsDir = path.join(projectDir, 'data', `test-platform-directory-uploads-${process.pid}-${Date.now()}`);
  const profiles = {
    'admin-token': { username: 'XuJiaJie', nickname: 'Hewson（许嘉杰）', wecomUserId: 'XuJiaJie' },
    'finance-token': { username: 'MaYunJie', nickname: 'Jet（马云杰）', wecomUserId: 'MaYunJie' },
    'outside-token': { username: 'Outside', nickname: '外部成员', wecomUserId: 'Outside' },
  };
  const roles = { 'admin-token': ['admin'], 'finance-token': ['finance'], 'outside-token': ['consultant'] };
  const mockPlatform = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!profiles[token]) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ detail: 'invalid token' })); return; }
    let data;
    if (url.pathname === '/api/auth/me') data = profiles[token];
    else if (url.pathname === '/api/data-dist/my-roles') data = { roles: roles[token] };
    else if (url.pathname === '/api/data-dist/user-groups' && token === 'admin-token') data = [
      { group_code: 'admin', group_name: '管理员', members: [{ wecom_user_id: 'XuJiaJie', display_name: 'Hewson（许嘉杰）' }] },
      { group_code: 'finance', group_name: '财务组', members: [{ wecom_user_id: 'MaYunJie', display_name: 'Jet（马云杰）' }] },
      { group_code: 'consultant', group_name: '顾问', members: [{ wecom_user_id: 'Outside', display_name: '外部成员' }] },
    ];
    else { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ detail: 'forbidden' })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 20000, data, msg: 'success' }));
  });
  await new Promise(resolve => mockPlatform.listen(mockPort, '127.0.0.1', resolve));
  const authChild = spawn(process.execPath, ['app.mjs'], { cwd: projectDir, env: {
    ...process.env, NODE_ENV: 'test', AUTH_MODE: 'platform', PORT: String(appPort), DB_FILE: authDbPath, UPLOADS_DIR: authUploadsDir,
    APP_BASE_PATH: '/platform/finance', PUBLIC_BASE_URL: 'https://anqiaoyiminxq.com/platform/finance', FINANCE_ALLOWED_ORIGIN: 'https://anqiaoyiminxq.com', SESSION_SECRET: 'test-session-secret-with-more-than-32-characters',
    PLATFORM_API_BASE_URL: `http://127.0.0.1:${mockPort}/api`, PLATFORM_LOGIN_URL: '/platform/login'
  }, stdio: 'ignore' });
  try {
    let started = false;
    for (let index = 0; index < 40; index++) { try { if ((await fetch(`${appBase}/api/health`)).ok) { started = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(started, true);
    const missing = await fetch(`${appBase}/api/auth/platform-session`, { method: 'POST' });
    assert.equal(missing.status, 401);
    const denied = await fetch(`${appBase}/api/auth/platform-session`, { method: 'POST', headers: { authorization: 'Bearer outside-token' } });
    assert.equal(denied.status, 403); assert.match((await denied.json()).error, /不在财务模块授权范围/);
    const financeSession = await fetch(`${appBase}/api/auth/platform-session`, { method: 'POST', headers: { authorization: 'Bearer finance-token' } });
    assert.equal(financeSession.status, 200); const financeCookieHeader = String(financeSession.headers.get('set-cookie')); const financeCookie = financeCookieHeader.split(';')[0];
    assert.match(financeCookieHeader, /^wecom_finance_session=/); assert.match(financeCookieHeader, /Path=\/platform\/finance/); assert.match(financeCookieHeader, /SameSite=Strict/); assert.match(financeCookieHeader, /; Secure/);
    const financeBootstrap = await fetch(`${appBase}/api/bootstrap?company=gz&period=2026-06`, { headers: { cookie: financeCookie } });
    assert.equal(financeBootstrap.status, 200); assert.equal((await financeBootstrap.json()).employee.key, 'MaYunJie');
    const adminSession = await fetch(`${appBase}/api/auth/platform-session`, { method: 'POST', headers: { authorization: 'Bearer admin-token' } });
    assert.equal(adminSession.status, 200); const cookie = String(adminSession.headers.get('set-cookie')).split(';')[0];
    const bootstrapResponse = await fetch(`${appBase}/api/bootstrap?company=gz&period=2026-06`, { headers: { cookie } });
    const bootstrap = await bootstrapResponse.json();
    assert.equal(bootstrap.employee.key, 'XuJiaJie'); assert.match(bootstrap.employee.department, /管理员/);
    const platformDb = new TestDatabase(authDbPath, { readonly: true });
    try {
      const employees = platformDb.prepare("SELECT employee_key AS employeeKey FROM employees WHERE active = 1 AND directory_source = 'platform' ORDER BY employee_key").all();
      const sync = platformDb.prepare("SELECT status, employee_count AS employeeCount FROM directory_sync_state WHERE source = 'platform'").get();
      assert.deepEqual(employees.map(item => item.employeeKey), ['MaYunJie', 'XuJiaJie']);
      assert.deepEqual(sync, { status: 'success', employeeCount: 2 });
    } finally { platformDb.close(); }
  } finally {
    authChild.kill(); await new Promise(resolve => authChild.exitCode === null ? authChild.once('exit', resolve) : resolve());
    await new Promise(resolve => mockPlatform.close(resolve)); fs.rmSync(authUploadsDir, { recursive: true, force: true }); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${authDbPath}${suffix}`, { force: true });
  }
});

test('基础路径注入覆盖首页静态资源和前端请求', async () => {
  const basePathPort = testPort + 2; const basePathBase = `http://127.0.0.1:${basePathPort}`;
  const basePathDbDir = path.join(projectDir, 'data', `test-base-path-db-${process.pid}-${Date.now()}`);
  const basePathDb = path.join(basePathDbDir, 'report-board.db');
  const basePathUploads = path.join(projectDir, 'data', `test-base-path-uploads-${process.pid}-${Date.now()}`);
  const basePathChild = spawn(process.execPath, ['app.mjs'], { cwd: projectDir, env: {
    ...process.env, NODE_ENV: 'test', AUTH_MODE: 'demo', PORT: String(basePathPort), DB_FILE: basePathDb, UPLOADS_DIR: basePathUploads,
    APP_BASE_PATH: '/report', PUBLIC_BASE_URL: 'https://qiandianxiaoq.com/report'
  }, stdio: 'ignore' });
  try {
    let started = false;
    for (let index = 0; index < 40; index++) { try { if ((await fetch(`${basePathBase}/api/health`)).ok) { started = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(started, true);
    const html = await (await fetch(`${basePathBase}/`)).text();
    assert.match(html, /content="\/report"/);
    assert.match(html, /href="\/report\/styles\.css"/);
    assert.match(html, /src="\/report\/app\.js"/);
    const frontend = await (await fetch(`${basePathBase}/app.js`)).text();
    assert.match(frontend, /fetch\(appUrl\(url\)/);
    assert.match(frontend, /api\/auth\/platform-session/);
    assert.match(frontend, /aqllm_tob_auth/);
    assert.doesNotMatch(frontend, /aqllm:finance-access-token|refreshToken/);
  } finally {
    basePathChild.kill(); await new Promise(resolve => basePathChild.exitCode === null ? basePathChild.once('exit', resolve) : resolve());
    fs.rmSync(basePathUploads, { recursive: true, force: true }); fs.rmSync(basePathDbDir, { recursive: true, force: true });
  }
});

test('管理员可以读取历史版本和汇总/明细', async () => {
  const summary = await request('/api/reports/income_statement/summary?company=gz&period=2026-06');
  assert.equal(summary.response.status, 200);
  assert.ok(summary.payload.snapshot.version >= 1);
  assert.ok(summary.payload.lines.length > 0);
  assert.ok(summary.payload.lines.some(line => /营业收入/.test(line.name)));
  assert.ok(summary.payload.trend.length > 0);
  assert.ok(summary.payload.trend.every(item => item.lines.some(line => /营业收入/.test(line.name))));
  const versions = await request('/api/reports/income_statement/versions?company=gz&period=2026-06');
  assert.equal(versions.response.status, 200);
  assert.ok(versions.payload.versions.every(item => item.source.includes('explicit-test-fixture')));
  const detail = await request(`/api/reports/income_statement/detail?company=gz&period=2026-06&version=${summary.payload.snapshot.version}`);
  assert.equal(detail.response.status, 200);
  assert.ok(Array.isArray(detail.payload.rows));
  const lineDetail = await request(`/api/reports/income_statement/detail?company=gz&period=2026-06&version=${summary.payload.snapshot.version}&line=revenue&search=${encodeURIComponent('主营业务收入')}`);
  assert.equal(lineDetail.response.status, 200);
  assert.equal(lineDetail.payload.line, 'revenue');
  assert.ok(lineDetail.payload.rawRows.length > 0);
});

test('员工权限隔离汇总与明细', async () => {
  const viewerSummary = await request('/api/reports/cash_flow/summary?company=sz&period=2026-06', 'viewer');
  assert.equal(viewerSummary.response.status, 200);
  const viewerDetail = await request('/api/reports/cash_flow/detail?company=sz&period=2026-06', 'viewer');
  assert.equal(viewerDetail.response.status, 403);
  const accountantCashDetail = await request('/api/reports/cash_flow/detail?company=gz&period=2026-06', 'accountant');
  assert.equal(accountantCashDetail.response.status, 403);
  const accountantOtherCompany = await request('/api/reports/income_statement/summary?company=sz&period=2026-06', 'accountant');
  assert.equal(accountantOtherCompany.response.status, 403);
});

test('启动信息按当前员工返回逐报表明细权限', async () => {
  const admin = (await request('/api/bootstrap?company=gz&period=2026-06', 'admin')).payload;
  assert.equal(admin.reportDetailAccess.balance_sheet, true);
  assert.equal(admin.reportDetailAccess.income_statement, true);
  assert.equal(admin.reportDetailAccess.consolidated_income_statement, false);
  assert.equal(admin.reportDetailAccess.revenue_profit_consolidated_income_statement, false);
  assert.equal(admin.reportDetailAccess.cash_flow, true);
  assert.equal(admin.reportDetailAccess.trial_balance, true);
  assert.equal(admin.reportDetailAccess.journal, true);

  const viewer = (await request('/api/bootstrap?company=sz&period=2026-06', 'viewer')).payload;
  assert.deepEqual(viewer.reportDetailAccess, {
    balance_sheet: false,
    income_statement: false,
    consolidated_income_statement: false,
    revenue_profit_consolidated_income_statement: false,
    revenue_statistics: false,
    payroll_statement: false,
    quotation_ledger: false,
    consultant_spend_revenue: false,
    cash_flow: false,
    trial_balance: false,
    journal: false
  });
});

test('无明细权限时隐藏报表点击提示并把金额渲染为普通文本', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  assert.match(frontend, /reportDetailAccess\?\.\[state\.reportType\] === true/);
  assert.match(frontend, /search && canViewCurrentReportDetail\(\)/);
  assert.match(frontend, /canViewDetail \? '<div class="standard-hint">/);
  assert.match(frontend, /canViewCurrentReportDetail\(\) \? '<div class="original-hint">/);
  assert.doesNotMatch(frontend, /当前员工只有汇总权限，未开放明细下钻/);
});

test('未上传公司期间返回统一空态且不复用其他公司模板', async () => {
  const reportTypes = ['balance_sheet', 'income_statement', 'cash_flow', 'trial_balance', 'journal'];
  for (const reportType of reportTypes) {
    const result = await request(`/api/reports/${reportType}/raw?company=sz&period=2026-07`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.meta.noData, true);
    assert.equal(result.payload.meta.status, 'missing');
    assert.equal(result.payload.meta.fileName, '暂无已上传数据');
    assert.deepEqual(result.payload.raw.rows, []);
    assert.doesNotMatch(JSON.stringify(result.payload), /青岛|152562\.38|181660\.30/);
  }
  const summary = await request('/api/reports/income_statement/summary?company=sz&period=2026-07');
  assert.equal(summary.response.status, 404);
  const versions = await request('/api/reports/income_statement/versions?company=sz&period=2026-07');
  assert.deepEqual(versions.payload.versions, []);
  const cash = await request('/api/analysis/cash-flow?company=sz&period=2026-07');
  const business = await request('/api/analysis/main-business?company=sz&period=2026-07&year=2026');
  const expenses = await request('/api/analysis/expenses?company=sz&period=2026-07&year=2026');
  assert.equal(cash.payload.source.noData, true);
  assert.equal(business.payload.source.noData, true);
  assert.equal(expenses.payload.finance.source.noData, true);
  assert.doesNotMatch(JSON.stringify([cash.payload, business.payload, expenses.payload]), /青岛|152562\.38|181660\.30/);
});

test('只有管理员可以读取和修改权限矩阵', async () => {
  const matrix = await request('/api/admin/roles', 'admin');
  assert.equal(matrix.response.status, 200);
  assert.ok(matrix.payload.scopes.some(scope => scope.roleKey === 'accountant' && scope.reportType === 'income_statement' && scope.level === 'detail'));
  assert.ok(matrix.payload.detailPreferences.some(item => item.roleKey === 'manager' && item.showDirection === true));
  const forbidden = await request('/api/admin/roles', 'manager');
  assert.equal(forbidden.response.status, 403);
});

test('管理员可全局开关员工水印，普通员工不可修改', async () => {
  const initial = await request('/api/bootstrap?company=gz&period=2026-06');
  assert.equal(initial.payload.reportWatermarkEnabled, false);
  const enabled = await post('/api/admin/report-watermark', { enabled: true });
  assert.equal(enabled.response.status, 200); assert.equal(enabled.payload.enabled, true);
  const inherited = await request('/api/bootstrap?company=gz&period=2026-06', 'viewer');
  assert.equal(inherited.payload.reportWatermarkEnabled, true);
  const forbidden = await post('/api/admin/report-watermark', { enabled: false }, 'viewer');
  assert.equal(forbidden.response.status, 403);
  const invalid = await post('/api/admin/report-watermark', { enabled: 'yes' });
  assert.equal(invalid.response.status, 400);
  const disabled = await post('/api/admin/report-watermark', { enabled: false });
  assert.equal(disabled.response.status, 200); assert.equal(disabled.payload.enabled, false);
});

test('顶部只保留当前员工信息且报表水印仅应用于报表和明细页', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const watermarkStart = frontend.indexOf('function applyReportWatermark');
  const watermarkSource = frontend.slice(watermarkStart, frontend.indexOf('async function refresh(', watermarkStart));
  assert.match(html, /id="employee-display"/);
  assert.doesNotMatch(html, /企微认证|id="role-badge"|class="local-badge"/);
  assert.match(frontend, /employeeDisplay\.textContent = `\$\{bootstrap\.employee\.name\} · \$\{bootstrap\.employee\.department\}`/);
  assert.match(frontend, /\/api\/admin\/report-watermark/);
  assert.match(frontend, /const reportPageTypes = \['balance_sheet', 'income_statement', 'consolidated_income_statement', revenueProfitReportType, 'cash_flow', 'trial_balance', 'journal'\]/);
  assert.match(watermarkSource, /const reportPages = \[\.\.\.reportPageTypes, revenueStatisticsReportType, financialBriefModuleKey\]/);
  assert.match(watermarkSource, /state\.page !== 'journal_detail'/);
  assert.match(watermarkSource, /employee\.name.*employee\.department.*currentCompanyName\(\)/);
  assert.doesNotMatch(watermarkSource, /uploads|permissions|database_admin|cash_analysis/);
});

test('顶部分享入口只复制安全链接且不再依赖旧财务企微应用', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  assert.match(html, /id="share-entry"/); assert.match(html, /id="share-modal"/); assert.match(html, /id="share-send"/);
  assert.match(html, /og:title/); assert.match(html, /og:image/); assert.match(html, /链接不携带登录凭证/);
  assert.match(html, /anqiaoyiminxq\.com/); assert.doesNotMatch(html, /qiandianxiaoq\.com/);
  assert.match(frontend, /navigator\.clipboard\.writeText/); assert.match(frontend, /复制链接后到企微发送/);
  assert.doesNotMatch(frontend, /\/api\/wecom\/js-sdk-config|wx\.agentConfig|shareAppMessage|res\.wx\.qq\.com/);
  assert.doesNotMatch(frontend, /WECOM_SECRET|SESSION_SECRET|wecom_finance_session/);
});

test('顶部右侧提供返回企业中台入口且由服务端安全注入地址', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const backend = fs.readFileSync(path.join(projectDir, 'app.mjs'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  assert.match(html, /class="portal-return" href="__PORTAL_HOME_URL__"/);
  assert.match(html, /返回桉侨企业中台主页面/);
  assert.match(backend, /PORTAL_HOME_URL \|\| '\/platform\/'/);
  assert.match(backend, /replaceAll\('__PORTAL_HOME_URL__', portalHomeUrl\)/);
  assert.match(stylesheet, /\.portal-return\{/);
  assert.match(stylesheet, /@media\(max-width:560px\)[^{]*\{\.portal-return/);
});

test('平台生产模式通过小Q身份与动态成员组建立短期财务会话', () => {
  const backend = fs.readFileSync(path.join(projectDir, 'app.mjs'), 'utf8');
  const readiness = fs.readFileSync(path.join(projectDir, 'deploy', 'check-readiness.mjs'), 'utf8');
  assert.match(backend, /platformJson\('\/auth\/me', accessToken\)/);
  assert.match(backend, /platformJson\('\/data-dist\/my-roles', accessToken\)/);
  assert.match(backend, /normalizePlatformIdentity\(profile, platformRoles\)/);
  assert.match(backend, /type: 'platform-session'/);
  assert.doesNotMatch(backend, /open\.weixin\.qq\.com|WECOM_SECRET|WECOM_AGENT_ID|WECOM_CORP_ID/);
  assert.match(readiness, /'PLATFORM_API_BASE_URL'/);
  assert.doesNotMatch(readiness, /WECOM_SECRET|ACCESS_ALLOWED_WECOM_USER_IDS/);
});

test('财务接口拒绝非许可来源并统一返回无缓存安全响应头', async () => {
  const allowed = await fetch(`${base}/api/health`, { headers: { origin: base, 'sec-fetch-site': 'same-origin' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
  assert.match(allowed.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(allowed.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(allowed.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(allowed.headers.get('x-frame-options'), 'DENY');
  const rejected = await fetch(`${base}/api/health`, { headers: { origin: 'https://anqiaoyiminxq.com', 'sec-fetch-site': 'same-site' } });
  assert.equal(rejected.status, 403);
  assert.match((await rejected.json()).error, /请求来源不允许/);
});

test('小Q仅作为身份提供方且平台请求固定为无正文 GET 白名单', () => {
  const backend = fs.readFileSync(path.join(projectDir, 'app.mjs'), 'utf8');
  const calls = [...backend.matchAll(/platformJson\('([^']+)'/g)].map(match => match[1]);
  assert.deepEqual([...new Set(calls)].sort(), ['/auth/me', '/data-dist/my-roles', '/data-dist/user-groups']);
  assert.match(backend, /allowedPlatformIdentityPaths = new Set\(\['\/auth\/me', '\/data-dist\/my-roles', '\/data-dist\/user-groups'\]\)/);
  assert.match(backend, /method: 'GET',[\s\S]*body: undefined/);
});

test('同源财务路径只读取小Q短期令牌并加固服务端代理边界', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const proxy = fs.readFileSync(path.join(projectDir, 'deploy', 'nginx', 'platform-finance.conf'), 'utf8');
  const envTemplate = fs.readFileSync(path.join(projectDir, 'deploy', '.env.production.example'), 'utf8');
  assert.match(frontend, /localStorage\.getItem\(platformAuthStorageKey\)/);
  assert.doesNotMatch(frontend, /localStorage\.setItem\(platformAuthStorageKey|refreshToken|access_token=/);
  assert.match(envTemplate, /APP_BASE_PATH=\/platform\/finance/);
  assert.match(envTemplate, /PUBLIC_BASE_URL=https:\/\/anqiaoyiminxq\.com\/platform\/finance/);
  assert.doesNotMatch(envTemplate, /finance\.anqiaoyiminxq\.com|PLATFORM_AUTH_BRIDGE_URL/);
  assert.match(proxy, /location \^~ \/platform\/finance\//);
  assert.match(proxy, /proxy_pass http:\/\/127\.0\.0\.1:3180\//);
  assert.match(proxy, /access_log off/); assert.match(proxy, /proxy_request_buffering off/); assert.match(proxy, /proxy_buffering off/); assert.match(proxy, /proxy_cache off/);
  assert.match(proxy, /deny 127\.0\.0\.1/); assert.match(proxy, /deny 8\.163\.36\.95/); assert.match(proxy, /deny 172\.16\.0\.0\/12/);
  assert.match(proxy, /worker-src 'none'/); assert.doesNotMatch(proxy, /Access-Control-Allow-Origin/i);
});

test('生产容器使用专用用户且隔离检查覆盖数据挂载、Socket、网络和回环端口', () => {
  const dockerfile = fs.readFileSync(path.join(projectDir, 'Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(projectDir, 'deploy', 'compose.production.yml'), 'utf8');
  const runtimeCheck = fs.readFileSync(path.join(projectDir, 'deploy', 'check-runtime-isolation.mjs'), 'utf8');
  const harden = fs.readFileSync(path.join(projectDir, 'deploy', 'harden-finance-data.sh'), 'utf8');
  const databaseBackup = fs.readFileSync(path.join(projectDir, 'deploy', 'backup-database.mjs'), 'utf8');
  const offsiteBackup = fs.readFileSync(path.join(projectDir, 'deploy', 'offsite-backup.sh'), 'utf8');
  assert.match(dockerfile, /APP_UID=20117/); assert.match(dockerfile, /USER \$\{APP_UID\}:\$\{APP_GID\}/);
  assert.match(dockerfile, /ARG NPM_REGISTRY=https:\/\/registry\.npmjs\.org/); assert.match(dockerfile, /npm ci --omit=dev --registry="\$\{NPM_REGISTRY\}"/);
  assert.match(compose, /user: "20117:20117"/); assert.match(compose, /127\.0\.0\.1:3180:3180/); assert.match(compose, /read_only: true/);
  assert.equal(runtimeCheck.includes('docker\\.sock'), true); assert.match(runtimeCheck, /network', 'inspect'/); assert.match(runtimeCheck, /3180\/tcp/); assert.match(runtimeCheck, /其他容器/);
  assert.match(harden, /expected_root=\/data\/data\/wecom-finance-report-board/); assert.match(harden, /目录 0700 · 文件 0600/);
  assert.match(databaseBackup, /chmodSync\(destination, 0o600\)/);
  assert.match(offsiteBackup, /chmod 0600 "\$status_file"/);
});

test('工资表与顾问消耗表固定为内部数据源且任何角色都不能整表浏览或导出', async () => {
  for (const reportType of ['payroll_statement', 'consultant_spend_revenue']) for (const action of ['raw', 'summary', 'detail', 'versions', 'export']) {
    const suffix = action === 'export' ? '&level=summary' : '';
    const response = await request(`/api/reports/${reportType}/${action}?company=group&period=2026-07${suffix}`, 'admin');
    assert.equal(response.response.status, 403);
    assert.match(response.payload.error, /敏感数据源不提供整表浏览或导出/);
  }
  const scopeDb = new TestDatabase(testDbPath, { readonly: true });
  try { for (const reportType of ['payroll_statement', 'consultant_spend_revenue']) assert.equal(scopeDb.prepare('SELECT COUNT(*) AS count FROM role_report_scopes WHERE report_type = ?').get(reportType).count, 0); }
  finally { scopeDb.close(); }
  const backend = fs.readFileSync(path.join(projectDir, 'app.mjs'), 'utf8');
  assert.match(backend, /sourceOnlyReportTypes = new Set\(\[payrollStatementReportType, quotationLedgerReportType, consultantSpendRevenueReportType\]\)/);
  assert.match(backend, /DELETE FROM role_report_scopes WHERE report_type = \?/);
});

test('原始报表普通区域与页面背景融合且保留特别标色行', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  assert.match(html, /\.original-report\{background:transparent/);
  assert.match(html, /\.original-heading\{[^}]*background:transparent/);
  assert.match(html, /\.original-table\{[^}]*background:transparent/);
  assert.match(html, /\.original-table th,\.original-table td\{[^}]*background:transparent/);
  assert.match(html, /\.original-table-scroll\{[^}]*background:transparent/);
  assert.match(html, /\.original-table \.original-section td\{background:#c4c4c4/);
  assert.match(html, /\.original-table \.original-total td\{background:#ffe69b/);
});

test('原始报表字号随内容宽度缩放且窄屏保留可读列宽', () => {
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  assert.match(html, /\.original-report\{container-type:inline-size\}/);
  assert.match(html, /\.original-table\{font-size:clamp\(10px,1cqw,13px\)\}/);
  assert.match(html, /\.original-table th,\.original-table td\{padding-inline:clamp\(2px,\.28cqw,5px\)\}/);
  assert.match(html, /@media\(min-width:701px\)[\s\S]*\.trial-layout\{min-width:960px\}/);
  assert.match(html, /@media\(max-width:700px\)[\s\S]*\.trial-layout\{min-width:1180px\}/);
});

test('原始报表裁掉末尾空行且利润表在净利润处收口', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const helperSource = frontend.slice(frontend.indexOf('const cellText'), frontend.indexOf('const statementMeta'));
  const context = { result: null };
  vm.runInNewContext(`${helperSource}; result = { trimTrailingEmptyRows, rowsThroughLastMatch };`, context);
  const sourceRows = [
    { row: 1, cells: ['营业收入', 100] },
    { row: 2, cells: ['', null] },
    { row: 3, cells: ['净利润', 0] },
    { row: 4, cells: ['', null] },
    { row: 5, cells: [] }
  ];
  const trimmed = context.result.trimTrailingEmptyRows(sourceRows);
  assert.equal(trimmed.map(row => row.row).join(','), '1,2,3');
  assert.equal(sourceRows.length, 5);
  assert.ok((frontend.match(/trimTrailingEmptyRows\(/g) || []).length >= 6);
  const reportRows = context.result.rowsThroughLastMatch([
    { row: 31, cells: ['所得税费用'] },
    { row: 32, cells: ['四、净利润（净亏损以“-”号填列）'] },
    { row: 33, cells: ['', null] },
    { row: 40, cells: ['项目2', '预算毛利'] }
  ], row => String(row.cells?.[0] || '').includes('净利润'));
  assert.equal(reportRows.map(row => row.row).join(','), '31,32');
  assert.match(frontend, /rowsThroughLastMatch\(allRows\.filter[\s\S]*\/净利润\/\.test/);
});

test('看板导航按当前员工报表权限过滤', async () => {
  const accountant = await request('/api/bootstrap?company=gz&period=2026-06', 'accountant');
  assert.equal(accountant.response.status, 200);
  assert.deepEqual(accountant.payload.modules.map(item => item.key), ['home', 'financial_brief', 'balance_sheet', 'income_statement', 'cash_flow', 'cash_analysis', 'uploads']);
  assert.equal(accountant.payload.modules.find(item => item.key === 'cash_analysis')?.name, '资产净额分析');
  const otherCompany = await request('/api/bootstrap?company=sz&period=2026-06', 'accountant');
  assert.deepEqual(otherCompany.payload.modules.map(item => item.key), ['home', 'uploads']);
});

test('首页期间筛选返回当前员工可见的所有已发布报表期间', async () => {
  const bootstrap = (await request('/api/bootstrap?company=gz&period=2026-06')).payload;
  assert.deepEqual(bootstrap.availablePeriodsByCompany.gz, ['2026-08', '2026-07', '2026-06']);
  assert.deepEqual(bootstrap.availablePeriodsByCompany.sz, ['2026-06']);
  assert.ok(!bootstrap.availablePeriodsByCompany.gz.includes('2026-05'));
  const accountant = (await request('/api/bootstrap?company=gz&period=2026-06', 'accountant')).payload;
  assert.deepEqual(accountant.companies.map(item => item.key), ['gz']);
  assert.deepEqual(Object.keys(accountant.availablePeriodsByCompany), ['gz']);
});

test('只有全部公司范围的权限管理员可新增公司', async () => {
  const companyName = `测试分公司-${process.pid}`;
  const forbidden = await post('/api/admin/companies', { name: companyName }, 'accountant');
  assert.equal(forbidden.response.status, 403);
  const created = await post('/api/admin/companies', { name: companyName });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.company.name, companyName);
  const duplicate = await post('/api/admin/companies', { name: companyName });
  assert.equal(duplicate.response.status, 409);
  const adminBootstrap = (await request('/api/bootstrap?company=gz&period=2026-06')).payload;
  assert.ok(adminBootstrap.companies.some(item => item.key === created.payload.company.key));
  const accountantBootstrap = (await request('/api/bootstrap?company=gz&period=2026-06', 'accountant')).payload;
  assert.ok(!accountantBootstrap.companies.some(item => item.key === created.payload.company.key));
});

test('权限设置接受全部公司范围并归一化为通配范围', async () => {
  const matrix = await request('/api/admin/roles');
  const preset = matrix.payload.roleDefaults.find(item => item.roleKey === 'viewer');
  const saved = await post('/api/admin/employee-permission-profile', {
    employeeKey: 'new_employee', presetRoleKey: 'viewer', permissionKeys: preset.permissionKeys,
    companyKeys: ['*', 'gz'], fromPeriod: '2020-01', toPeriod: '2099-12',
    accountVisibility: 'level1', showDirection: false, showFullEntry: false
  });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(saved.payload.profile.companyKeys, ['*']);
});

test('全部不可见范围不返回公司期间或数据模块且服务端拒绝越权上传', async () => {
  const matrix = await request('/api/admin/roles');
  const preset = matrix.payload.roleDefaults.find(item => item.roleKey === 'viewer');
  const saved = await post('/api/admin/employee-permission-profile', {
    employeeKey: 'new_employee', presetRoleKey: 'viewer', permissionKeys: [...preset.permissionKeys, 'module.uploads.upload'],
    companyKeys: [], fromPeriod: '2020-01', toPeriod: '2099-12',
    accountVisibility: 'level1', showDirection: false, showFullEntry: false
  });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(saved.payload.profile.companyKeys, []);

  const bootstrap = await request('/api/bootstrap?company=gz&period=2026-06', 'new_employee');
  assert.equal(bootstrap.response.status, 200);
  assert.deepEqual(bootstrap.payload.companies, []);
  assert.deepEqual(bootstrap.payload.availablePeriodsByCompany, {});
  assert.deepEqual(bootstrap.payload.modules.map(item => item.key), ['home']);
  assert.equal(bootstrap.payload.canUploadReports, false);
  assert.doesNotMatch(JSON.stringify(bootstrap.payload), /全部不可见/);

  const report = await request('/api/reports/income_statement/summary?company=gz&period=2026-06', 'new_employee');
  assert.equal(report.response.status, 403);
  const upload = await post('/api/uploads', {
    companyKey: 'gz', period: '2026-06', reportType: 'income_statement', fileName: '越权测试.json', fileType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify({ income_statement: { sourceSheet: '利润表', rows: [{ row: 1, cells: ['项目', '本期金额'] }] } })).toString('base64')
  }, 'new_employee');
  assert.equal(upload.response.status, 403);
  assert.match(upload.payload.error, /数据范围权限/);
});

test('管理员保存的全局看板模块顺序应用于所有公司，普通员工不可修改', async () => {
  const original = (await request('/api/bootstrap?company=gz&period=2026-06')).payload.moduleOrder.map(item => item.key);
  assert.equal(original.indexOf('uploads') + 1, original.indexOf('activity_logs'));
  assert.equal(original.indexOf('activity_logs') + 1, original.indexOf('permissions'));
  const reordered = [...original].reverse();
  const saved = await post('/api/admin/module-order', { order: reordered });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.payload.scope, 'all_companies');
  const visible = await request('/api/bootstrap?company=gz&period=2026-06', 'viewer');
  assert.equal(visible.payload.moduleOrderScope, 'all_companies');
  assert.deepEqual(visible.payload.modules.map(item => item.key), ['home', ...reordered.filter(key => visible.payload.modules.some(item => item.key === key))]);
  for (const companyKey of ['gz', 'sz', 'group']) {
    const companyBootstrap = await request(`/api/bootstrap?company=${companyKey}&period=2026-06`);
    const visibleKeys = new Set(companyBootstrap.payload.modules.map(item => item.key));
    assert.equal(companyBootstrap.payload.moduleOrderScope, 'all_companies');
    assert.deepEqual(companyBootstrap.payload.modules.map(item => item.key), ['home', ...reordered.filter(key => visibleKeys.has(key))]);
  }
  const forbidden = await post('/api/admin/module-order', { order: original }, 'viewer');
  assert.equal(forbidden.response.status, 403);
  const restored = await post('/api/admin/module-order', { order: original });
  assert.equal(restored.response.status, 200);
  const persisted = (await request('/api/bootstrap?company=gz&period=2026-06')).payload.moduleOrder;
  assert.deepEqual(persisted.map(item => item.key), original);
  assert.equal(new Set(persisted.map(item => item.sortOrder)).size, persisted.length);
});

test('全部公司范围管理员可保存全局公司顺序，普通员工不可修改', async () => {
  const bootstrap = await request('/api/bootstrap?company=gz&period=2026-06');
  const original = bootstrap.payload.companies.map(item => item.key);
  assert.equal(bootstrap.payload.canReorderCompanies, true);
  const reordered = [...original.slice(1), original[0]];
  const saved = await post('/api/admin/company-order', { order: reordered });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(saved.payload.order, reordered);
  const inherited = await request('/api/bootstrap?company=gz&period=2026-06', 'viewer');
  assert.deepEqual(inherited.payload.companies.map(item => item.key), reordered.filter(key => inherited.payload.companies.some(item => item.key === key)));
  assert.equal(inherited.payload.canReorderCompanies, false);
  const forbidden = await post('/api/admin/company-order', { order: original }, 'viewer');
  assert.equal(forbidden.response.status, 403);
  const restored = await post('/api/admin/company-order', { order: original });
  assert.equal(restored.response.status, 200);
});

test('模块排序入口只在管理员左侧导航展示', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  const navSource = frontend.slice(frontend.indexOf('function renderNav'), frontend.indexOf('function animateAnalysisReflow'));
  const permissionsSource = frontend.slice(frontend.indexOf('async function renderPermissions'), frontend.indexOf('async function refresh('));
  assert.match(navSource, /canManagePermissions/);
  assert.match(navSource, /nav-drag-handle/);
  assert.match(navSource, /\/api\/admin\/module-order/);
  assert.match(navSource, /submenuFor/);
  assert.match(navSource, /data-nav-submenu-for/);
  assert.match(navSource, /querySelectorAll\('\.nav-item\[data-module-key\]'\)/);
  assert.match(frontend, /revealActiveNav/);
  assert.match(stylesheet, /\.topbar\{position:relative;top:auto;z-index:2;height:auto/);
  assert.match(stylesheet, /\.sidebar\{position:sticky;top:0;z-index:6/);
  assert.match(stylesheet, /\.nav-item\{flex:0 0 auto;width:auto/);
  assert.match(stylesheet, /touch-action:pan-x/);
  assert.match(stylesheet, /@media\(max-width:600px\)[\s\S]*\.nav-drag-handle\{display:none\}/);
  assert.match(stylesheet, /\.nav-submenu\[hidden\]\{display:none\}/);
  assert.match(stylesheet, /@media\(max-width:900px\)[\s\S]*\.nav-submenu\{display:flex;flex-direction:row/);
  assert.doesNotMatch(permissionsSource, /module-order-list|看板模块顺序|bindModuleOrder/);
});

test('首页使用卡片与月份按钮选择公司和期间，不再加载财务总览', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const homeSource = frontend.slice(frontend.indexOf('function renderHome'), frontend.indexOf('function bindCommonFilters'));
  assert.match(homeSource, /home-company-option/);
  assert.match(homeSource, /home-period-option/);
  assert.match(homeSource, /选择本次查看范围/);
  assert.match(frontend, /state\.periodExplicit && companyPeriods\.includes\(state\.period\)/);
  assert.match(frontend, /state\.periodExplicit = false/);
  assert.doesNotMatch(frontend, /renderDashboard|dashboard-page|财务总览/);
});

test('管理员长按整张公司卡片拖动排序且不显示独立手柄', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  const reorderSource = frontend.slice(frontend.indexOf('function bindHomeCompanyReorder'), frontend.indexOf('function renderHome'));
  assert.match(reorderSource, /setTimeout\(activate, 460\)/);
  assert.match(reorderSource, /home-company-drag-ghost/);
  assert.match(reorderSource, /animateAnalysisReflow/);
  assert.match(reorderSource, /\/api\/admin\/company-order/);
  assert.doesNotMatch(reorderSource, /drag-handle/);
  assert.match(stylesheet, /\.home-company-option\.home-company-option-dragging/);
  assert.match(stylesheet, /\.company-reorder-enabled \.home-company-option\{[^}]*cursor:pointer/);
  assert.match(stylesheet, /\.company-reorder-active \.home-company-option[^}]*\{cursor:grabbing\}/);
  assert.match(stylesheet, /@keyframes company-drag-pulse/);
});

test('手机端模块切换无过渡且只渲染最后一次报表请求', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  assert.match(frontend, /const navigateToPage = page => \{[^}]*syncPageVisibility\(\);[^}]*refresh\(\{ reloadBootstrap: false \}\)/);
  assert.match(frontend, /async function refresh\(\{ reloadBootstrap = true \} = \{\}\) \{\s*const refreshRevision = \+\+pageRequestRevision;\s*syncPageVisibility\(\)/);
  assert.match(frontend, /matchMedia\?\.\('\(max-width: 900px\)'\)\.matches[\s\S]*prefers-reduced-motion[\s\S]*return/);
  assert.doesNotMatch(frontend, /void activeHost\.offsetWidth/);
  assert.match(frontend, /animation\.id = 'page-arrival'/);
  assert.match(frontend, /scrollTo\(\{ left, behavior: 'auto' \}\)/);
  assert.match(frontend, /let reportRequestRevision = 0/);
  assert.match(frontend, /const requestRevision = \+\+reportRequestRevision/);
  assert.match(frontend, /requestRevision === reportRequestRevision/);
  assert.match(frontend, /if \(!isCurrent\(\)\) return/);
  assert.match(stylesheet, /@media\(max-width:900px\)\{\.app-shell\{animation:none\}\.page\.page-entering\{animation:none\}\.nav-item\{transition:none/);
  assert.match(stylesheet, /\.nav-item:hover:not\(\.active\)\{background:transparent/);
  assert.doesNotMatch(stylesheet, /page-arrive-mobile/);
});

test('上传页使用独立公司期间选择器且移除全局范围锁定', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  const uploadSource = frontend.slice(frontend.indexOf('async function renderUploads'), frontend.indexOf('async function renderDatabaseAdmin'));
  assert.match(uploadSource, /page\.querySelector\('\.page-title \.filter'\)\?\.remove\(\)/);
  assert.match(uploadSource, /upload-picker-trigger/);
  assert.match(uploadSource, /upload-month-grid/);
  assert.match(uploadSource, /clear-selected-files/);
  assert.match(uploadSource, /data-slot-clear/);
  assert.match(uploadSource, /data-upload-slot/);
  assert.match(uploadSource, /slot\.ondragenter = allowDrop/);
  assert.match(uploadSource, /slot\.ondragover = allowDrop/);
  assert.match(uploadSource, /slot\.ondrop = async event/);
  assert.match(uploadSource, /setFile\(type, file\)/);
  assert.match(uploadSource, /每个报表位置一次只能拖入一个文件/);
  assert.match(stylesheet, /\.upload-slot\.dragging/);
  assert.match(uploadSource, /delete selected\[type\]/);
  assert.match(uploadSource, /state\.uploadCompany/);
  assert.match(uploadSource, /state\.uploadPeriod/);
  assert.match(uploadSource, /upload-select-all/);
  assert.match(uploadSource, /全选本页可处理/);
  assert.match(uploadSource, /upload-history-company/);
  assert.match(uploadSource, /upload-history-period/);
  assert.match(uploadSource, /upload-history-report/);
  assert.match(uploadSource, /data-upload-history-view="pending"/);
  assert.match(uploadSource, /data-upload-history-view="versions"/);
  assert.match(uploadSource, /upload-history-pagination/);
  assert.match(uploadSource, /state\.uploadSelectedFiles/);
  assert.match(uploadSource, /const requestRevision = \+\+uploadHistoryRequestRevision/);
  assert.match(uploadSource, /api\(`\/api\/uploads\?\$\{historyParams\}`, \{ cache: 'no-store' \}\)/);
  assert.match(uploadSource, /requestRevision !== uploadHistoryRequestRevision/);
  assert.match(uploadSource, /startUploadHistoryMutation/);
  assert.match(uploadSource, /uploadHistoryMutationInFlight/);
  assert.match(uploadSource, /finally \{ finishUploadHistoryMutation\(\); \}/);
  assert.match(uploadSource, /page\.querySelectorAll\('\[data-publish\]'\)/);
  assert.match(uploadSource, /page\.querySelectorAll\('\[data-preview-upload\]'\)/);
  assert.doesNotMatch(uploadSource, /document\.querySelectorAll\('\[data-(?:publish|preview-upload)\]'\)/);
  assert.match(uploadSource, /发布已选/);
  assert.match(uploadSource, /\/api\/uploads\/bulk-publish/);
  assert.match(uploadSource, /撤回并删除已选/);
  assert.match(uploadSource, /\/api\/uploads\/bulk-delete/);
  assert.match(uploadSource, /window\.confirm/);
  assert.match(uploadSource, /COMPANY_MISMATCH/);
  assert.match(uploadSource, /PERIOD_MISMATCH/);
  assert.match(uploadSource, /地区不一致可能导致报表归属错误/);
  assert.match(uploadSource, /即将发布为当前版本，请核对/);
  assert.match(uploadSource, /setUploadPeriod\(period/);
  assert.match(uploadSource, /const successfulScopes = \[\]/);
  assert.match(uploadSource, /state\.uploadHistoryView = 'pending'; state\.uploadHistoryPage = 1/);
  assert.match(uploadSource, /state\.uploadHistoryFilters = \{ company: successfulCompanies\.length === 1 \? successfulCompanies\[0\] : '', period: successfulPeriods\.length === 1 \? successfulPeriods\[0\] : '', reportType: '', search: '' \}/);
  assert.match(stylesheet, /\.upload-history-filters/);
  assert.match(stylesheet, /\.upload-history-tabs/);
  assert.match(stylesheet, /\.upload-history-group/);
  assert.doesNotMatch(uploadSource, /state\.company = companyKey; state\.period = period/);
  const backend = fs.readFileSync(path.join(projectDir, 'app.mjs'), 'utf8');
  const publishSource = backend.slice(backend.indexOf('const uploadActionMatch'), backend.indexOf('const rawMatch'));
  assert.match(publishSource, /publishCompanyHint/);
  assert.match(publishSource, /COMPANY_MISMATCH/);
  assert.match(publishSource, /publishPeriodHint/);
  assert.match(publishSource, /PERIOD_MISMATCH/);
});

test('页面与后台运行版本一致且旧响应不能覆盖上传操作后的列表', async () => {
  const bootstrap = await request('/api/bootstrap?company=gz&period=2026-06');
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.payload.appVersion, '1.1.50');
  const index = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  assert.match(index, /<meta name="app-version" content="1\.1\.50">/);
  assert.match(frontend, /const expectedAppVersion = document\.querySelector\('meta\[name="app-version"\]'\)/);
  assert.match(frontend, /bootstrap\?\.appVersion === expectedAppVersion/);
  assert.match(frontend, /APP_VERSION_MISMATCH/);
  assert.match(frontend, /当前页面已停止提交数据/);
});

test('管理员可分别保存分析板块顺序，普通员工只读', async () => {
  const bootstrap = await request('/api/bootstrap?company=gz&period=2026-06');
  const original = bootstrap.payload.analysisBlockOrder.cash_analysis;
  assert.ok(original.includes('cash_metric'));
  assert.ok(original.includes('core_liquidity_trend'));
  assert.ok(!original.includes('cash_flow_structure'));
  assert.ok(bootstrap.payload.analysisBlockOrder.main_business_analysis.includes('business_detail'));
  assert.ok(bootstrap.payload.analysisBlockOrder.expense_analysis.includes('finance_table'));
  assert.deepEqual(bootstrap.payload.analysisBlockOrder.group_profit_analysis, ['group_profit_source', 'revenue_cost_trend', 'period_expense_trend', 'net_profit_trend']);
  const reordered = [...original.slice(1), original[0]];
  const saved = await post('/api/admin/analysis-block-order', { pageKey: 'cash_analysis', order: reordered });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(saved.payload.order, reordered);
  const inherited = await request('/api/bootstrap?company=gz&period=2026-06', 'manager');
  assert.deepEqual(inherited.payload.analysisBlockOrder.cash_analysis, reordered);
  const anotherCompany = await request('/api/bootstrap?company=qd&period=2026-06');
  assert.deepEqual(anotherCompany.payload.analysisBlockOrder.cash_analysis, reordered);
  const forbidden = await post('/api/admin/analysis-block-order', { pageKey: 'cash_analysis', order: original }, 'manager');
  assert.equal(forbidden.response.status, 403);
  const restored = await post('/api/admin/analysis-block-order', { pageKey: 'cash_analysis', order: original });
  assert.equal(restored.response.status, 200);
});

test('分析布局升级只追加新板块且生产数据目录独立于应用版本', () => {
  const backend = fs.readFileSync(path.join(projectDir, 'app.mjs'), 'utf8');
  const compose = fs.readFileSync(path.join(projectDir, 'deploy', 'compose.production.yml'), 'utf8');
  assert.match(backend, /const appendMissingAnalysisBlocks = pageKey =>/);
  assert.match(backend, /reduce\(\(maximum, row\) => Math\.max\(maximum, Number\(row\.sortOrder\) \|\| 0\), 0\) \+ 10/);
  assert.match(backend, /analysis_block_order_stable_upgrade_v1/);
  assert.match(backend, /按现有查询顺序重编号，不按默认布局覆盖管理员顺序/);
  assert.match(compose, /\/data\/data\/wecom-finance-report-board:\/var\/lib\/wecom-finance/);
  assert.match(compose, /DB_FILE: \/var\/lib\/wecom-finance\/report-board\.db/);
});

test('分析拖动稳定命中、锁定落位并以完整顺序保存，切页请求丢弃过期结果', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  const layoutSource = frontend.slice(frontend.indexOf('function animateAnalysisReflow'), frontend.indexOf('async function loadBootstrap'));
  assert.match(layoutSource, /requestAnimationFrame\(\(\) =>/);
  assert.match(layoutSource, /Math\.hypot\(x - session\.startX, y - session\.startY\) < 5/);
  assert.match(layoutSource, /window\.addEventListener\('pointerup', finishFromWindow, true\)/);
  assert.match(layoutSource, /window\.addEventListener\('pointercancel', cancelFromWindow, true\)/);
  assert.match(layoutSource, /lockDragHandles\(true\)/);
  assert.match(layoutSource, /restoreVisibleOrder\(session\.initialVisibleOrder\)/);
  assert.match(layoutSource, /const order = fullOrderFor\(nextVisibleOrder\)/);
  assert.match(layoutSource, /已应用于所有公司和员工/);
  assert.match(layoutSource, /duration: 180[\s\S]*cubic-bezier/);
  assert.match(stylesheet, /\.analysis-drag-overlay:hover>\.analysis-drag-handle/);
  assert.match(stylesheet, /\.analysis-drag-ghost\{/);
  assert.match(stylesheet, /\.analysis-block-dragging\{[^}]*pointer-events:none/);
  assert.match(stylesheet, /\.analysis-layout-saving>\.analysis-layout-block\{cursor:wait\}/);
  assert.match(frontend, /let pageRequestRevision = 0/);
  assert.match(frontend, /revision !== pageRequestRevision \|\| state\.page !== 'expense_analysis'/);
  assert.doesNotMatch(frontend.slice(frontend.indexOf('async function renderCashAnalysis'), frontend.indexOf('const coreLiquidityTrendSvg')), /\/api\/reports\/cash_flow\/summary/);
});

test('资产净额分析前端展示可拖动的核心流动性月度趋势图', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  assert.match(frontend, /const coreLiquidityTrendSvg = trend =>/);
  assert.match(frontend, /年核心流动性净额月度变动/);
  assert.match(frontend, /dataAnalysisBlock|dataset\.analysisBlock = 'core_liquidity_trend'/);
  assert.match(frontend, /未上传月份留空，不按零值处理/);
});

test('应收应付净额构成使用问号说明并可向右展开四类构成列', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  assert.match(frontend, /analysis-components-toggle/);
  assert.match(frontend, /analysis-help-popover/);
  ['应收账款', '其他应收款', '应付账款（减）', '其他应付款（减）'].forEach(label => assert.match(frontend, new RegExp(label)));
  assert.match(frontend, /其他应付款（减）<\/th><th class="analysis-note-heading"[^>]*>说明<\/th>/);
  assert.match(frontend, /应收账款＋其他应收款－应付账款－其他应付款/);
  assert.match(stylesheet, /\.analysis-component-col\{display:none/);
  assert.match(stylesheet, /\.components-expanded \.analysis-component-col\{display:table-cell/);
  assert.match(stylesheet, /\.net-position-table th:nth-child\(2\)\{text-align:right/);
  assert.match(stylesheet, /\.net-position-table th\.analysis-note-heading\{text-align:center/);
});

test('三类分析页的标注子模块均可独立授权且接口同步裁剪数据', async () => {
  const matrix = await request('/api/admin/roles');
  const analysisNodes = matrix.payload.permissionCatalog.find(group => group.id === 'analysis').children;
  const expectedBlocks = {
    cash_analysis: ['net_positions', 'cash_accounts', 'other_liquidity', 'core_liquidity_trend'],
    main_business_analysis: ['business_detail', 'project_change', 'gross_trend'],
    expense_analysis: ['selling_table', 'selling_share', 'selling_trend', 'admin_table', 'admin_share', 'admin_trend', 'finance_table', 'finance_share', 'finance_methods']
  };
  for (const [pageKey, blocks] of Object.entries(expectedBlocks)) {
    const node = analysisNodes.find(item => item.id === `${pageKey}_permissions`);
    assert.deepEqual(node.children.map(item => item.key), [`module.${pageKey}.view`, ...blocks.map(block => `module.${pageKey}.${block}.view`)]);
  }
  const preset = matrix.payload.roleDefaults.find(item => item.roleKey === 'regional_manager');
  Object.entries(expectedBlocks).forEach(([pageKey, blocks]) => blocks.forEach(block => assert.ok(preset.permissionKeys.includes(`module.${pageKey}.${block}.view`))));

  const removedKeys = new Set(['module.cash_analysis.cash_accounts.view', 'module.main_business_analysis.business_detail.view', 'module.expense_analysis.selling_table.view', 'module.expense_analysis.finance_table.view']);
  const permissionKeys = preset.permissionKeys.filter(key => !removedKeys.has(key));
  const saved = await post('/api/admin/employee-permission-profile', {
    employeeKey: 'regional_gm', presetRoleKey: 'regional_manager', permissionKeys,
    companyKeys: ['gz'], fromPeriod: '2026-01', toPeriod: '2026-12', accountVisibility: 'level1', showDirection: false, showFullEntry: false
  });
  assert.equal(saved.response.status, 200);
  const bootstrap = (await request('/api/bootstrap?company=gz&period=2026-06', 'regional_gm')).payload;
  assert.equal(bootstrap.modules.some(item => item.key === 'cash_analysis'), true);
  assert.equal(bootstrap.analysisBlockAccess.cash_analysis.cash_accounts, false);
  assert.equal(bootstrap.analysisBlockAccess.cash_analysis.net_positions, true);
  assert.equal(bootstrap.analysisBlockAccess.main_business_analysis.business_detail, false);
  assert.equal(bootstrap.analysisBlockAccess.expense_analysis.selling_table, false);
  assert.equal(bootstrap.analysisBlockAccess.expense_analysis.selling_share, true);
  const cash = await request('/api/analysis/cash-flow?company=gz&period=2026-06&year=2026', 'regional_gm');
  assert.equal(cash.response.status, 200); assert.deepEqual(cash.payload.cashAccounts, []);
  const business = await request('/api/analysis/main-business?company=gz&period=2026-06&year=2026', 'regional_gm');
  assert.equal(business.response.status, 200); assert.deepEqual(business.payload.detailRows, []); assert.equal(typeof business.payload.current.projectCount, 'number');
  const expenses = await request('/api/analysis/expenses?company=gz&period=2026-06&year=2026', 'regional_gm');
  assert.equal(expenses.response.status, 200);
  assert.ok(expenses.payload.selling.rows.every(row => !Object.hasOwn(row, 'prior') && !Object.hasOwn(row, 'currentDetails')));
  assert.ok(expenses.payload.finance.rows.every(row => !Object.hasOwn(row, 'fee') && !Object.hasOwn(row, 'currentDetails')));

  const orphan = await post('/api/admin/employee-permission-profile', {
    employeeKey: 'regional_gm', presetRoleKey: 'regional_manager', permissionKeys: ['module.cash_analysis.net_positions.view'],
    companyKeys: ['gz'], fromPeriod: '2026-01', toPeriod: '2026-12', accountVisibility: 'level1', showDirection: false, showFullEntry: false
  });
  assert.equal(orphan.response.status, 400);
  assert.match(orphan.payload.error, /先开启资产净额分析浏览权限/);
  assert.equal((await post('/api/admin/employee-permission-profile', {
    employeeKey: 'regional_gm', presetRoleKey: 'regional_manager', permissionKeys: preset.permissionKeys,
    companyKeys: ['gz'], fromPeriod: '2026-01', toPeriod: '2026-12', accountVisibility: 'level1', showDirection: false, showFullEntry: false
  })).response.status, 200);

  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  assert.match(frontend, /analysisBlockAccess\?\.\[pageKey\]/);
  assert.match(frontend, /blockAccess\[block\.dataset\.analysisBlock\] === false\) block\.remove/);
  assert.match(frontend, /fullOrderFor\(visibleOrder\)/);
  const backend = fs.readFileSync(path.join(projectDir, 'app.mjs'), 'utf8');
  assert.match(backend, /analysis_block_permissions_all_marked_modules_v1/);
  assert.match(backend, /cashAccounts: access\.cash_accounts \? analysis\.cashAccounts : \[\]/);
});

test('四类分析页的每个子模块均可折叠展开并按员工保留状态', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  const layoutSource = frontend.slice(frontend.indexOf('const analysisCollapseStorageKey'), frontend.indexOf('async function loadBootstrap'));
  assert.match(layoutSource, /wecom-finance-analysis-collapsed:\$\{state\.employeeKey\}:\$\{pageKey\}/);
  assert.match(layoutSource, /window\.localStorage\?\.getItem/);
  assert.match(layoutSource, /window\.localStorage\?\.setItem/);
  assert.match(layoutSource, /analysis-block-body/);
  assert.match(layoutSource, /analysis-collapse-toggle/);
  assert.match(layoutSource, /analysis-collapse-summary/);
  assert.match(layoutSource, /aria-expanded/);
  assert.match(layoutSource, /body\.hidden = isCollapsed/);
  assert.ok(layoutSource.indexOf("block.appendChild(collapse)") < layoutSource.indexOf("if (!canReorder || isStatic) return"));
  assert.match(stylesheet, /\.analysis-collapsed\{height:54px!important;min-height:54px!important;overflow:hidden\}/);
  assert.match(stylesheet, /\.analysis-collapse-toggle\.is-collapsed svg\{transform:rotate\(180deg\)\}/);
  assert.match(stylesheet, /\.analysis-layout-editable>\.analysis-layout-block>\.analysis-collapse-toggle\{right:42px\}/);
});

test('管理员可按角色隐藏借贷方向，普通员工不可修改', async () => {
  const hidden = await post('/api/admin/set-detail-preference', { roleKey: 'manager', showDirection: false });
  assert.equal(hidden.response.status, 200);
  assert.equal(hidden.payload.showDirection, false);
  const managerDetail = await request('/api/reports/income_statement/detail?company=gz&period=2026-06', 'manager');
  assert.equal(managerDetail.response.status, 200);
  assert.equal(managerDetail.payload.showDirection, false);
  const forbidden = await post('/api/admin/set-detail-preference', { roleKey: 'manager', showDirection: true }, 'manager');
  assert.equal(forbidden.response.status, 403);
  const restored = await post('/api/admin/set-detail-preference', { roleKey: 'manager', showDirection: true });
  assert.equal(restored.response.status, 200);
});

test('管理员可按角色控制跳转明细是否展开完整分录', async () => {
  const hidden = await post('/api/admin/set-detail-preference', { roleKey: 'manager', showFullEntry: false });
  assert.equal(hidden.response.status, 200);
  assert.equal(hidden.payload.showFullEntry, false);
  const focused = await request('/api/reports/trial_balance/detail?company=gz&period=2026-08&search=银行存款', 'manager');
  assert.equal(focused.response.status, 200);
  assert.equal(focused.payload.showFullEntry, false);
  assert.ok(focused.payload.rawRows.length > 0);
  assert.ok(focused.payload.rawRows.every(row => String(row.cells?.[4] || '').includes('银行存款')));
  const shown = await post('/api/admin/set-detail-preference', { roleKey: 'manager', showFullEntry: true });
  assert.equal(shown.response.status, 200);
  const expanded = await request('/api/reports/trial_balance/detail?company=gz&period=2026-08&search=银行存款', 'manager');
  assert.equal(expanded.payload.showFullEntry, true);
  assert.ok(expanded.payload.rawRows.length >= focused.payload.rawRows.length);
  assert.ok(expanded.payload.rawRows.some(row => !String(row.cells?.[4] || '').includes('银行存款')));
});

test('上传批次可校验、发布并作为原始资料事实源', async () => {
  const raw = { balance_sheet: { sourceSheet: '资产负债表', maxRow: 2, maxCol: 3, rows: [{ row: 1, cells: ['项目', '期末余额', '年初余额'] }, { row: 2, cells: ['货币资金', 100, 80] }] } };
  const uploaded = await post('/api/uploads', { companyKey: 'gz', period: '2026-08', reportType: 'balance_sheet', fileName: 'upload-test.json', fileType: 'application/json', contentBase64: Buffer.from(JSON.stringify(raw)).toString('base64') });
  assert.equal(uploaded.response.status, 201);
  const forbidden = await post(`/api/uploads/${uploaded.payload.uploadKey}/publish`, {}, 'accountant');
  assert.equal(forbidden.response.status, 403);
  const published = await post(`/api/uploads/${uploaded.payload.uploadKey}/publish`, {});
  assert.equal(published.response.status, 200);
  const current = await request('/api/reports/balance_sheet/raw?company=gz&period=2026-08');
  assert.equal(current.response.status, 200);
  assert.equal(current.payload.meta.uploadKey, uploaded.payload.uploadKey);
  assert.equal(current.payload.meta.demo, false);
});

test('已校验上传记录可批量发布且普通会计无发布权限', async () => {
  const raw = {
    balance_sheet: { sourceSheet: '资产负债表', rows: [{ row: 1, cells: ['项目', '期末余额'] }, { row: 2, cells: ['货币资金', 500] }] },
    income_statement: { sourceSheet: '利润表', rows: [{ row: 1, cells: ['项目', '本期金额'] }, { row: 2, cells: ['营业收入', 800] }] }
  };
  const uploaded = await post('/api/uploads', { companyKey: 'gz', period: '2027-01', fileName: '2027.01广州桉侨汇总财务报表.json', fileType: 'application/json', contentBase64: Buffer.from(JSON.stringify(raw)).toString('base64') });
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.payload.uploadKeys.length, 2);
  const forbidden = await post('/api/uploads/bulk-publish', { uploadKeys: uploaded.payload.uploadKeys }, 'accountant');
  assert.equal(forbidden.response.status, 403);
  const published = await post('/api/uploads/bulk-publish', { uploadKeys: uploaded.payload.uploadKeys });
  assert.equal(published.response.status, 200);
  assert.equal(published.payload.publishedCount, 2);
  const batches = await request('/api/uploads?period=2027-01');
  assert.ok(uploaded.payload.uploadKeys.every(key => batches.payload.uploads.find(item => item.uploadKey === key)?.status === 'published'));
});

test('未发布记录可删除，当前发布可安全撤回并逐级恢复上一上传版本', async () => {
  const pendingRaw = {
    balance_sheet: { sourceSheet: '资产负债表', rows: [{ row: 1, cells: ['项目', '期末余额', '年初余额'] }, { row: 2, cells: ['货币资金', 120, 90] }] },
    income_statement: { sourceSheet: '利润表', rows: [{ row: 1, cells: ['项目', '行次', '本年累计金额', '本期金额'] }, { row: 2, cells: ['营业收入', 1, 300, 100] }] }
  };
  const uploaded = await post('/api/uploads', { companyKey: 'gz', period: '2026-12', fileName: '2026.12待发布汇总.json', fileType: 'application/json', contentBase64: Buffer.from(JSON.stringify(pendingRaw)).toString('base64') });
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.payload.uploadKeys.length, 2);
  const pendingView = await request('/api/uploads?company=gz&period=2026-12&view=pending&page=1&pageSize=5');
  assert.equal(pendingView.response.status, 200); assert.equal(pendingView.payload.total, 2); assert.equal(pendingView.payload.pageSize, 5);
  assert.equal(pendingView.payload.summary.pending, 2); assert.ok(pendingView.payload.filterOptions.periods.includes('2026-12'));
  assert.ok(pendingView.payload.uploads.every(item => !['published', 'superseded'].includes(item.status)));
  const pageClamped = await request('/api/uploads?company=gz&period=2026-12&view=pending&page=99&pageSize=5');
  assert.equal(pageClamped.payload.page, 1); assert.equal(pageClamped.payload.uploads.length, 2);
  const accountantOutsideScope = await request('/api/uploads?company=gz&period=2027-01&view=all', 'accountant');
  assert.equal(accountantOutsideScope.response.status, 200); assert.equal(accountantOutsideScope.payload.total, 0);
  assert.ok(accountantOutsideScope.payload.filterOptions.periods.every(item => item >= '2026-01' && item <= '2026-12'));
  assert.equal((await request('/api/uploads?view=unknown')).response.status, 400);
  const forbidden = await post('/api/uploads/bulk-delete', { uploadKeys: uploaded.payload.uploadKeys }, 'accountant');
  assert.equal(forbidden.response.status, 403);
  const deleted = await post('/api/uploads/bulk-delete', { uploadKeys: uploaded.payload.uploadKeys });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.payload.deletedCount, 2);
  const remaining = await request('/api/uploads?period=2026-12');
  assert.ok(uploaded.payload.uploadKeys.every(key => !remaining.payload.uploads.some(item => item.uploadKey === key)));

  const first = await post('/api/uploads', { companyKey: 'gz', period: '2026-12', reportType: 'balance_sheet', fileName: '2026.12第一版资产负债表.json', fileType: 'application/json', contentBase64: Buffer.from(JSON.stringify({ balance_sheet: pendingRaw.balance_sheet })).toString('base64') });
  assert.equal((await post(`/api/uploads/${first.payload.uploadKey}/publish`, {})).response.status, 200);
  const secondRaw = { balance_sheet: { ...pendingRaw.balance_sheet, rows: [{ row: 1, cells: ['项目', '期末余额', '年初余额'] }, { row: 2, cells: ['货币资金', 220, 190] }] } };
  const second = await post('/api/uploads', { companyKey: 'gz', period: '2026-12', reportType: 'balance_sheet', fileName: '2026.12第二版资产负债表.json', fileType: 'application/json', contentBase64: Buffer.from(JSON.stringify(secondRaw)).toString('base64') });
  assert.equal((await post(`/api/uploads/${second.payload.uploadKey}/publish`, {})).response.status, 200);

  const history = await request('/api/uploads?period=2026-12');
  assert.equal(history.payload.uploads.find(item => item.uploadKey === first.payload.uploadKey).status, 'superseded');
  assert.equal(history.payload.uploads.find(item => item.uploadKey === second.payload.uploadKey).status, 'published');
  const versionsView = await request('/api/uploads?company=gz&period=2026-12&reportType=balance_sheet&view=versions&page=1&pageSize=5');
  assert.equal(versionsView.payload.total, 2); assert.equal(versionsView.payload.summary.current, 1); assert.equal(versionsView.payload.summary.history, 1);
  assert.deepEqual(new Set(versionsView.payload.uploads.map(item => item.status)), new Set(['published', 'superseded']));
  const lockedHistory = await post('/api/uploads/bulk-delete', { uploadKeys: [first.payload.uploadKey] });
  assert.equal(lockedHistory.response.status, 409);
  const noPublishPermission = await post('/api/uploads/bulk-delete', { uploadKeys: [second.payload.uploadKey] }, 'accountant');
  assert.equal(noPublishPermission.response.status, 403);

  const rollback = await post('/api/uploads/bulk-delete', { uploadKeys: [second.payload.uploadKey] });
  assert.equal(rollback.response.status, 200);
  assert.equal(rollback.payload.withdrawnCount, 1);
  assert.equal(rollback.payload.restoredCount, 1);
  assert.equal(rollback.payload.noDataCount, 0);
  const restored = await request('/api/reports/balance_sheet/raw?company=gz&period=2026-12');
  assert.equal(restored.payload.meta.uploadKey, first.payload.uploadKey);

  const emptied = await post('/api/uploads/bulk-delete', { uploadKeys: [first.payload.uploadKey] });
  assert.equal(emptied.response.status, 200);
  assert.equal(emptied.payload.withdrawnCount, 1);
  assert.equal(emptied.payload.restoredCount, 0);
  assert.equal(emptied.payload.noDataCount, 1);
  const noData = await request('/api/reports/balance_sheet/raw?company=gz&period=2026-12');
  assert.equal(noData.payload.meta.noData, true);
});

test('文件地区与期间不符时逐项提示，正确范围可识别月份前缀工作表', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['科目编码', '科目名称', '期初借方', '期初贷方', '本期借方', '本期贷方', '累计借方', '累计贷方', '期末借方', '期末贷方'],
    ['1002', '银行存款', 100, 0, 20, 0, 20, 0, 120, 0]
  ]), '5月科目余额表');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '凭证号', '摘要', '科目编码', '科目名称', '借方金额', '贷方金额'],
    ['2026-05-08', '记-001', '收到服务款', '1002', '银行存款', 100, 0]
  ]), '5月序时账');
  const contentBase64 = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }).toString('base64');
  const changsha = await post('/api/admin/companies', { name: '长沙桉侨海外咨询服务有限公司' });
  assert.equal(changsha.response.status, 201);
  const companyMismatch = await post('/api/uploads', { companyKey: 'gz', period: '2026-06', fileName: '2026.5长沙桉桥财务报表.xlsx', contentBase64 });
  assert.equal(companyMismatch.response.status, 409);
  assert.equal(companyMismatch.payload.code, 'COMPANY_MISMATCH');
  assert.equal(companyMismatch.payload.detectedCompanyKey, changsha.payload.company.key);
  assert.equal(companyMismatch.payload.detectedCompanyName, '长沙桉侨海外咨询服务有限公司');
  const periodMismatch = await post('/api/uploads', { companyKey: changsha.payload.company.key, period: '2026-06', fileName: '2026.5长沙桉桥财务报表.xlsx', contentBase64 });
  assert.equal(periodMismatch.response.status, 409);
  assert.equal(periodMismatch.payload.code, 'PERIOD_MISMATCH');
  assert.equal(periodMismatch.payload.detectedPeriod, '2026-05');
  assert.equal(periodMismatch.payload.selectedPeriod, '2026-06');
  const uploaded = await post('/api/uploads', { companyKey: changsha.payload.company.key, period: '2026-05', fileName: '2026.5长沙桉桥财务报表.xlsx', contentBase64 });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  assert.deepEqual(uploaded.payload.uploads.map(item => item.reportType).sort(), ['journal', 'trial_balance']);
  assert.ok(uploaded.payload.sheets.some(item => item.sourceSheet === '5月科目余额表'));
  assert.ok(uploaded.payload.sheets.some(item => item.sourceSheet === '5月序时账'));

});

test('上传自动裁剪异常尾部空白范围且真实有效范围超限时返回明确错误', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['项目', '年度累计', '前期累计金额', '本期金额'],
    ['销售商品、提供劳务收到的现金', 500, 0, 500]
  ]), '现金流量表-钱去向');
  const workpaperHeader = Array(16).fill(null); const workpaperRow = Array(16).fill(null);
  workpaperHeader[0] = '日期'; workpaperHeader[15] = '现金流量表项目';
  workpaperRow[0] = '2026-06-08'; workpaperRow[15] = '销售商品、提供劳务收到的现金';
  const workpaper = XLSX.utils.aoa_to_sheet([workpaperHeader, workpaperRow]);
  workpaper['!ref'] = 'A1:P1048576';
  XLSX.utils.book_append_sheet(workbook, workpaper, '现金流量表底稿6月');
  const workbookBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const uploaded = await post('/api/uploads', { companyKey: 'gz', period: '2026-06', fileName: '2026.6广州桉侨财务报表.xlsx', contentBase64: workbookBuffer.toString('base64') });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  const trimmed = uploaded.payload.sheets.find(item => item.reportType === 'cash_flow_workpaper');
  assert.equal(trimmed.trimmed, true); assert.equal(trimmed.declaredRange, 'A1:P1048576'); assert.equal(trimmed.effectiveRange, 'A1:P2'); assert.equal(trimmed.rows, 2);
  assert.match(uploaded.payload.trimmedSheets.join(''), /现金流量表底稿6月/);
  const history = await request('/api/uploads?company=gz&period=2026-06');
  assert.match(history.payload.uploads.find(item => item.uploadKey === uploaded.payload.uploadKey)?.validationMessage || '', /已自动裁剪异常空白范围/);

  const oversizedWorkbook = XLSX.utils.book_new(); const oversizedJournal = XLSX.utils.aoa_to_sheet([['日期']]);
  oversizedJournal.A200001 = { t: 's', v: '异常尾行' }; oversizedJournal['!ref'] = 'A1:A200001';
  XLSX.utils.book_append_sheet(oversizedWorkbook, oversizedJournal, '6月序时账');
  const rejected = await post('/api/uploads', { companyKey: 'gz', period: '2026-06', reportType: 'journal', fileName: '2026.6广州桉侨序时账.xlsx', contentBase64: XLSX.write(oversizedWorkbook, { type: 'buffer', bookType: 'xlsx' }).toString('base64') });
  assert.equal(rejected.response.status, 400);
  assert.match(rejected.payload.error, /工作表“6月序时账”有效数据范围 A1:A200001/);
  assert.match(rejected.payload.error, /超过上传限制/);
});

test('普通利润表将合并单元格中的日期序号规范化并清除隐藏旧期间', async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    [null, '利润表', null, null, null],
    [null, '会小企02表', null, null, null],
    [null, '编制单位：桉侨有限公司', 46204, '2025年1月', '单位：元'],
    [null, '项目', '行次', '本年累计金额', '本期金额'],
    [null, '一、营业收入', 1, 1000, 200]
  ]);
  sheet['!merges'] = [XLSX.utils.decode_range('C3:D3')];
  XLSX.utils.book_append_sheet(workbook, sheet, '利润表');
  const contentBase64 = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }).toString('base64');
  const uploaded = await post('/api/uploads', { companyKey: 'gz', period: '2026-07', reportType: 'income_statement', fileName: '2026.7广州桉侨财务报表.xlsx', contentBase64 });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  const preview = await request(`/api/reports/income_statement/raw?company=gz&period=2026-07&uploadKey=${uploaded.payload.uploadKey}`);
  assert.equal(preview.response.status, 200);
  const metaCells = preview.payload.raw.rows.find(row => row.row === 3)?.cells || [];
  assert.equal(metaCells[2], '2026年7月');
  assert.equal(metaCells[3], null);
});

test('原始报表标题以已校验上传期间为准，不展示源表隐藏旧期间', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const metaSource = frontend.slice(frontend.indexOf('const statementPeriodText'), frontend.indexOf('const reportSourceNote'));
  const context = {
    result: null,
    cellText: value => String(value ?? '').trim(),
    escapeHtml: value => String(value ?? '')
  };
  vm.runInNewContext(`${metaSource}; result = statementMeta;`, context);
  const html = context.result({ rows: [{ cells: [null, '编制单位：桉侨有限公司', 46204, '2025年1月', '单位：元'] }] }, '利润表', { company: '广州桉侨有限公司', period: '2026-07' });
  assert.match(html, /2026年7月/);
  assert.doesNotMatch(html, /2025年1月/);
});

test('原始科目余额表支持金额下钻到来源行', async () => {
  const raw = await request('/api/reports/trial_balance/raw?company=gz&period=2026-06');
  assert.equal(raw.response.status, 200);
  assert.ok(raw.payload.raw.rows.length > 0);
  const detail = await request('/api/reports/trial_balance/detail?company=gz&period=2026-06&search=银行存款');
  assert.equal(detail.response.status, 200);
  assert.ok(detail.payload.rawRows.length > 0);
});

test('报表与序时账分批上传后，利润表金额仍可下钻到已发布序时账', async () => {
  const period = '2026-10';
  const income = { income_statement: { sourceSheet: '利润表', rows: [
    { row: 1, cells: ['项目', '行次', '本年累计金额', '本期金额'] },
    { row: 2, cells: ['一、营业收入', 1, 500, 500] }
  ] } };
  const journal = { journal: { sourceSheet: '序时账', rows: [
    { row: 1, cells: ['日期', '凭证号', '摘要', '科目编码', '科目名称', '借方金额', '贷方金额'] },
    { row: 2, cells: ['2026-10-08', '记-001', '确认服务收入', '6001001', '主营业务收入-服务收入', 0, 500] },
    { row: 3, cells: ['2026-10-08', '记-001', '确认服务收入', '1002001', '银行存款', 500, 0] },
    { row: 4, cells: ['2026-10-31', '记-099', '10月 结转损益', '6001001', '主营业务收入-服务收入', 500, 0] },
    { row: 5, cells: ['2026-10-31', '记-099', '', '4103001', '本年利润', 0, 500] }
  ] } };
  const incomeUpload = await post('/api/uploads', { companyKey: 'gz', period, reportType: 'income_statement', fileName: '2026.10利润表.json', fileType: 'application/json', contentBase64: Buffer.from(JSON.stringify(income)).toString('base64') });
  const journalUpload = await post('/api/uploads', { companyKey: 'gz', period, reportType: 'journal', fileName: '2026.10序时账.json', fileType: 'application/json', contentBase64: Buffer.from(JSON.stringify(journal)).toString('base64') });
  assert.equal((await post(`/api/uploads/${incomeUpload.payload.uploadKey}/publish`, {})).response.status, 200);
  assert.equal((await post(`/api/uploads/${journalUpload.payload.uploadKey}/publish`, {})).response.status, 200);

  const publishedJournal = await request(`/api/reports/journal/raw?company=gz&period=${period}`);
  assert.equal(publishedJournal.payload.raw.rows.length, 5, JSON.stringify(publishedJournal.payload));
  assert.ok(publishedJournal.payload.raw.rows.some(row => /结转\s*损益/.test(String(row.cells?.[2] || ''))));
  const detail = await request(`/api/reports/income_statement/detail?company=gz&period=${period}&search=${encodeURIComponent('一、营业收入')}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.payload.rawRows.length, 2, JSON.stringify(detail.payload));
  assert.ok(detail.payload.rawRows.some(row => String(row.cells?.[4] || '').includes('主营业务收入')));
  assert.equal(detail.payload.rawRows.some(row => String(row.cells?.[1] || '') === '记-099'), false);
  assert.equal(detail.payload.rawRows.some(row => /结转\s*损益/.test(String(row.cells?.[2] || ''))), false);
});

test('现金流量表金额下钻读取隐藏底稿并按现金流项目筛选', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['项目', '年度累计', '前期累计金额', '本期金额'],
    ['销售商品、提供劳务收到的现金', 0, 0, 500]
  ]), '现金流量表-钱去向');
  const header = Array(20).fill('');
  [header[0], header[1], header[2], header[4], header[5], header[6], header[17], header[18], header[19]] = ['日期', '凭证号', '摘要', '科目名称', '借方本币', '贷方本币', '备注', '现金流量表项目', '备注'];
  const detailA = Array(20).fill(null); const detailB = Array(20).fill(null);
  [detailA[0], detailA[1], detailA[2], detailA[4], detailA[5], detailA[6], detailA[17], detailA[18], detailA[19]] = ['2026-11-08', '记-001', '客户支付服务费', '银行存款', 300, 0, '合同A', '销售商品、提供劳务收到的现金', 'R-SALES'];
  [detailB[0], detailB[1], detailB[2], detailB[4], detailB[5], detailB[6], detailB[17], detailB[18], detailB[19]] = ['2026-11-12', '记-002', '客户支付服务费', '银行存款', 200, 0, '合同B', '销售商品、提供劳务收到的现金', 'R-SALES'];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([header, detailA, detailB]), '11月现金流量表底稿');
  workbook.Workbook = { Sheets: [{ name: '现金流量表-钱去向', Hidden: 0 }, { name: '11月现金流量表底稿', Hidden: 1 }] };
  const uploaded = await post('/api/uploads', { companyKey: 'gz', period: '2026-11', reportType: 'cash_flow', fileName: '2026.11现金流量表.xlsx', contentBase64: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }).toString('base64') });
  assert.equal(uploaded.response.status, 201);
  assert.equal((await post(`/api/uploads/${uploaded.payload.uploadKey}/publish`, {})).response.status, 200);

  const detail = await request(`/api/reports/cash_flow/detail?company=gz&period=2026-11&search=${encodeURIComponent('销售商品、提供劳务收到的现金')}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.payload.detailKind, 'cash_flow_workpaper');
  assert.equal(detail.payload.detailSourceSheet, '11月现金流量表底稿');
  assert.equal(detail.payload.workpaperRows.length, 2);
  assert.equal(detail.payload.workpaperRows.reduce((sum, row) => sum + row.debit, 0), 500);
});

test('现金流量表底稿明细不展示底稿备注', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const rendererSource = frontend.slice(frontend.indexOf('function cashFlowWorkpaperTableHtml'), frontend.indexOf('async function renderJournalDetail'));
  const context = {
    result: null,
    escapeHtml: value => String(value ?? ''),
    statementAmount: value => Number(value || 0).toFixed(2)
  };
  vm.runInNewContext(`${rendererSource}; result = cashFlowWorkpaperTableHtml;`, context);
  const html = context.result([{ date: '2026-07-31', voucher: '记-3', summary: '客户收款', account: '银行存款', debit: 19950, credit: 0, project: '销售商品、提供劳务收到的现金', note: '合同备注', rule: 'R-SALES' }]);
  assert.equal((html.match(/<th>/g) || []).length, 7);
  assert.doesNotMatch(html, /底稿备注|合同备注|R-SALES/);
  assert.match(html, /现金流量表项目/);
});

test('现金流量表识别年份累计表头且仅本期金额可下钻', () => {
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const rendererSource = frontend.slice(frontend.indexOf('function renderCashFlowStatement'), frontend.indexOf('function renderTrialBalance'));
  const page = { innerHTML: '' };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const statementAmount = value => value === null || value === undefined || value === '' ? '' : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const context = {
    result: null,
    state: { company: 'gz', period: '2026-07' },
    api: async () => ({}),
    currentCompanyName: () => '广州桉侨',
    $: () => page,
    escapeHtml,
    statementAmount,
    statementCell: (value, search = '') => statementAmount(value) && search ? `<button data-search="${escapeHtml(search)}">${statementAmount(value)}</button>` : escapeHtml(statementAmount(value)),
    rawValue: (row, index) => row?.cells?.[index] ?? '',
    cellText: value => String(value ?? '').trim(),
    headerIndex: (cells, matcher, start = 0) => cells.findIndex((value, index) => index >= start && matcher.test(String(value ?? '').trim())),
    statementMeta: () => '',
    reportSourceNote: () => '',
    canViewCurrentReportDetail: () => true,
    trimTrailingEmptyRows: rows => rows,
    bindRawNumbers: () => {},
    cashFlowAnalysisButtonHtml: () => '<button id="cash-flow-analysis-open">现金收支分析</button>',
    bindCashFlowAnalysis: () => {}
  };
  vm.runInNewContext(`${rendererSource}; result = renderCashFlowStatement;`, context);
  context.result({ raw: { rows: [
    { row: 1, cells: ['2026年7月现金流量表'] },
    { row: 3, cells: ['项目', '2026年累计', '前期累计金额', '本期金额'] },
    { row: 4, cells: ['销售商品、提供劳务收到的现金', 80366.04, 5800, 74566.04] }
  ] } });
  assert.match(page.innerHTML, /<th>2026年累计<\/th>/);
  assert.match(page.innerHTML, />80,366\.04<\/td>/);
  assert.equal((page.innerHTML.match(/data-search=/g) || []).length, 1);
  assert.match(page.innerHTML, /年度累计和前期累计金额仅作对比展示，不跳转/);
});

test('资产净额分析按青岛口径计算核心净流动性头寸', async () => {
  const analysis = await request('/api/analysis/cash-flow?company=gz&period=2026-06&year=2026');
  assert.equal(analysis.response.status, 200);
  assert.equal(analysis.payload.metrics.cash, 152562.38);
  assert.ok(Math.abs(analysis.payload.metrics.internalNet - 174982.49) < 0.001);
  assert.ok(Math.abs(analysis.payload.metrics.customerReceivables - 742930.30) < 0.001);
  assert.ok(Math.abs(analysis.payload.metrics.costPayables - 616540.53) < 0.001);
  assert.ok(Math.abs(analysis.payload.metrics.coreNetLiquidity - 327544.87) < 0.001);
  assert.ok(Math.abs(analysis.payload.metrics.staticLiquidity - 453934.64) < 0.001);
  assert.equal(analysis.payload.monthlyTrend.length, 12);
  assert.equal(analysis.payload.monthlyTrend[5].month, '2026-06');
  assert.equal(analysis.payload.monthlyTrend[5].available, true);
  assert.ok(Math.abs(analysis.payload.monthlyTrend[5].coreNetLiquidity - 327544.87) < 0.001);
  assert.equal(analysis.payload.monthlyTrend[0].available, false);
  assert.equal(analysis.payload.monthlyTrend[0].coreNetLiquidity, null);
  const guangzhou = analysis.payload.internalPositions.find(item => item.party === '广州桉侨移民咨询服务有限公司');
  const guangzhouAdjustment = analysis.payload.internalPositions.find(item => item.party === '广州桉侨移民咨询服务有限公司 调整');
  assert.deepEqual(guangzhou?.accountCodes, ['1122001', '2202003', '2241005']);
  assert.deepEqual(guangzhouAdjustment?.accountCodes, ['1221005']);
  const normalDetail = await request(`/api/reports/trial_balance/detail?company=gz&period=2026-06&search=${encodeURIComponent(guangzhou.party)}&accountCodes=${encodeURIComponent(guangzhou.accountCodes.join(','))}`);
  const adjustmentDetail = await request(`/api/reports/trial_balance/detail?company=gz&period=2026-06&search=${encodeURIComponent(guangzhouAdjustment.party)}&accountCodes=${encodeURIComponent(guangzhouAdjustment.accountCodes.join(','))}`);
  assert.ok(normalDetail.payload.rawRows.some(row => guangzhou.accountCodes.includes(String(row.cells?.[3] || '').trim())));
  assert.ok(adjustmentDetail.payload.rawRows.some(row => guangzhouAdjustment.accountCodes.includes(String(row.cells?.[3] || '').trim())));

  const combinedOnlyPath = path.join(testUploadsDir, 'combined-only-journal-fallback.json');
  const combinedOnlyKey = `upl-combined-only-${process.pid}`; fs.writeFileSync(combinedOnlyPath, JSON.stringify({ journal: demoReports.journal }));
  const testDb = new TestDatabase(testDbPath); const timestamp = new Date().toISOString();
  try {
    testDb.prepare('INSERT INTO upload_batches(upload_key, employee_key, company_key, period, report_type, file_name, file_type, storage_path, raw_path, content_hash, status, validation_message, created_at, published_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(combinedOnlyKey, 'admin', 'gz', '2026-09', 'trial_balance', '汇总文件.json', 'application/json', combinedOnlyPath, combinedOnlyPath, 'combined-only-hash', 'published', '测试已发布汇总文件', timestamp, timestamp, '');
  } finally { testDb.close(); }
  const combinedOnlyDetail = await request(`/api/reports/trial_balance/detail?company=gz&period=2026-09&search=${encodeURIComponent(guangzhou.party)}&accountCodes=1122001`);
  assert.ok(combinedOnlyDetail.payload.rawRows.some(row => String(row.cells?.[3] || '').trim() === '1122001'));
});

test('主营业务分析按序时账聚合收入成本并受模块权限控制', async () => {
  const analysis = await request('/api/analysis/main-business?company=gz&period=2026-07&year=2026');
  assert.equal(analysis.response.status, 200);
  assert.equal(analysis.payload.detailRows.length, 12);
  assert.equal(analysis.payload.detailRows[0].contractNo, '20260717-1862');
  assert.equal(analysis.payload.detailRows[0].revenue, 76260.3);
  assert.equal(analysis.payload.detailRows[0].cost, 27035.38);
  assert.equal(analysis.payload.detailRows.find(row => row.contractNo === '20260727-1935').customerName, '王辉');
  assert.equal(analysis.payload.detailRows.find(row => row.contractNo === '20260728-1954').customerName, '刘佳');
  assert.equal(analysis.payload.monthlyTrend.length, 12);
  assert.equal(analysis.payload.monthlyTrend[6].grossProfit, 121412.22);
  const viewer = await request('/api/analysis/main-business?company=gz&period=2026-07', 'viewer');
  assert.equal(viewer.response.status, 403);
});

test('主营业务项目按序时账表头取值且不会把会计人员编号识别为项目', async () => {
  const journal = {
    sourceSheet: '12月序时账', maxRow: 3, maxCol: 18,
    rows: [
      { row: 1, cells: ['日期', '凭证号', '摘要', '科目编码', '科目名称', '借方金额', '贷方金额', '客户名称', '供应商编码', '供应商名称', '部门编码', '部门名称', '项目编码', '项目名称', '制单人', '审核人', '附件数', '备注'] },
      { row: 2, cells: ['2026-12-18', '记-25', '20261218-1793王炳几内亚比绍绿卡-读书，服务费16000元', '6001001', '主营业务收入-几内亚比绍绿卡-读书', 0, 16000, '', '', '', '', '', 'P001', '几内亚比绍绿卡-读书', '会计001', '会计002', 0, ''] },
      { row: 3, cells: ['2026-12-18', '记-25', '项目服务成本（摘要漏写订单号）', '6401001', '主营业务成本-几内亚比绍绿卡-读书', 6000, 0, '', '', '', '', '', '', '', '会计001', '会计002', 0, ''] }
    ]
  };
  const uploaded = await post('/api/uploads', {
    companyKey: 'gz', period: '2026-12', reportType: 'journal', fileName: '2026.12序时账.json', fileType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify({ journal })).toString('base64')
  });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  const batch = uploaded.payload.uploads?.[0] || uploaded.payload;
  assert.equal((await post(`/api/uploads/${batch.uploadKey}/publish`, {})).response.status, 200);
  const analysis = await request('/api/analysis/main-business?company=gz&period=2026-12&year=2026');
  assert.equal(analysis.response.status, 200);
  assert.equal(analysis.payload.detailRows.length, 1);
  assert.equal(analysis.payload.detailRows[0].contractNo, '20261218-1793');
  assert.equal(analysis.payload.detailRows[0].customerName, '王炳');
  assert.equal(analysis.payload.detailRows[0].projectName, '几内亚比绍绿卡-读书');
  assert.equal(analysis.payload.detailRows[0].cost, 6000);
  assert.deepEqual(analysis.payload.projectRows.map(row => row.projectName), ['几内亚比绍绿卡-读书']);
  assert.equal(analysis.payload.projectRows.some(row => /^会计\s*\d+$/i.test(row.projectName)), false);
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  assert.match(frontend, /row\.customerName \|\| '未识别客户'/);
  assert.match(frontend, /insertAdjacentHTML\('afterend', '<th>客户名称<\/th>'\)/);
  assert.match(stylesheet, /\.business-detail-table\{min-width:1040px\}/);
});

test('集团报单表按合同编号纠正主营业务客户和项目且保持分析专用', async () => {
  const period = '2028-01';
  const quotationBuffer = quotationLedgerWorkbookBuffer([
    { contractNo: '20260709-1825', customerName: '吴红翔', projectName: '瓦努阿图-护照' },
    { contractNo: 'AQ2026083696', customerName: '郑怡昕', projectName: '几内亚比绍绿卡-港投' }
  ]);
  const quotationUpload = await post('/api/uploads', {
    companyKey: 'group', reportType: 'quotation_ledger', fileName: '202502年报价单台账汇总黎 -0903.xlsx',
    contentBase64: quotationBuffer.toString('base64')
  });
  assert.equal(quotationUpload.response.status, 201, JSON.stringify(quotationUpload.payload));
  assert.deepEqual(quotationUpload.payload.uploads.map(item => item.reportType), ['quotation_ledger']);
  assert.equal(quotationUpload.payload.uploads[0].period, 'all-history');
  assert.equal(quotationUpload.payload.uploads[0].sourceVersion, '0903');
  assert.equal(quotationUpload.payload.sheets.find(item => item.reportType === 'quotation_ledger')?.rows, 3);
  const quotationKey = quotationUpload.payload.uploads[0].uploadKey;
  assert.equal((await post(`/api/uploads/${quotationKey}/publish`, {})).response.status, 200);
  const quotationHistory = await request('/api/uploads?company=group&period=all-history&reportType=quotation_ledger&view=versions');
  assert.equal(quotationHistory.response.status, 200);
  assert.equal(quotationHistory.payload.uploads[0].sourceVersion, '0903');

  const journal = {
    sourceSheet: '1月序时账', maxRow: 3, maxCol: 14,
    rows: [
      { row: 1, cells: ['日期', '凭证号', '摘要', '科目编码', '科目名称', '借方金额', '贷方金额', '客户名称', '供应商编码', '供应商名称', '部门编码', '部门名称', '项目编码', '项目名称'] },
      { row: 2, cells: ['2028-01-08', '记-001', '20260709-1825 确认服务收入', '6001001', '主营业务收入-旧项目名', 0, 30000, '旧客户名', '', '', '', '', 'P001', '旧项目名'] },
      { row: 3, cells: ['2028-01-08', '记-001', '20260709-1825 确认服务成本', '6401001', '主营业务成本-旧项目名', 12000, 0, '', '', '', '', '', 'P001', '旧项目名'] }
    ]
  };
  const journalUpload = await post('/api/uploads', {
    companyKey: 'sz', period, reportType: 'journal', fileName: '2028.01深圳序时账.json', fileType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify({ journal })).toString('base64')
  });
  assert.equal(journalUpload.response.status, 201, JSON.stringify(journalUpload.payload));
  assert.equal((await post(`/api/uploads/${journalUpload.payload.uploads[0].uploadKey}/publish`, {})).response.status, 200);

  const analysis = await request(`/api/analysis/main-business?company=sz&period=${period}&year=2028`);
  assert.equal(analysis.response.status, 200);
  assert.equal(analysis.payload.detailRows.length, 1);
  assert.equal(analysis.payload.detailRows[0].contractNo, '20260709-1825');
  assert.equal(analysis.payload.detailRows[0].customerName, '吴红翔');
  assert.equal(analysis.payload.detailRows[0].projectName, '瓦努阿图-护照');
  assert.equal(analysis.payload.detailRows[0].revenue, 30000);
  assert.equal(analysis.payload.detailRows[0].cost, 12000);
  assert.deepEqual(analysis.payload.quotationMatch, { currentContracts: 1, matchedContracts: 1 });
  assert.equal(analysis.payload.quotationSource.recordCount, 2);
  assert.equal(analysis.payload.quotationSource.sourceVersion, '0903');
  assert.equal((await request('/api/reports/quotation_ledger/raw?company=group&period=all-history')).response.status, 403);

  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  assert.match(frontend, /集团报单表（客户及项目匹配）/);
  assert.match(frontend, /覆盖全历史数据，版本取文件名末尾后缀/);
  assert.match(frontend, /客户和项目优先按合同编号精确匹配最新发布的集团报单表/);
});

test('主营业务成本可继承同凭证唯一订单号但不会误配多订单凭证', async () => {
  const journal = {
    sourceSheet: '2月序时账', maxRow: 4, maxCol: 14,
    rows: [
      { row: 1, cells: ['日期', '凭证号', '摘要', '科目编码', '科目名称', '借方金额', '贷方金额', '客户名称', '供应商编码', '供应商名称', '部门编码', '部门名称', '项目编码', '项目名称'] },
      { row: 2, cells: ['2027-02-20', '记-002', '20270220-2001 确认项目甲收入', '6001001', '主营业务收入-项目甲', 0, 1000, '客户甲', '', '', '', '', 'P001', '项目甲'] },
      { row: 3, cells: ['2027-02-20', '记-002', '20270220-2002 确认项目乙收入', '6001002', '主营业务收入-项目乙', 0, 800, '客户乙', '', '', '', '', 'P002', '项目乙'] },
      { row: 4, cells: ['2027-02-20', '记-002', '结转项目成本（摘要漏写订单号）', '6401001', '主营业务成本-其他', 300, 0, '', '', '', '', '', '', ''] }
    ]
  };
  const uploaded = await post('/api/uploads', {
    companyKey: 'sz', period: '2027-02', reportType: 'journal', fileName: '2027.02序时账.json', fileType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify({ journal })).toString('base64')
  });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  const batch = uploaded.payload.uploads?.[0] || uploaded.payload;
  assert.equal((await post(`/api/uploads/${batch.uploadKey}/publish`, {})).response.status, 200);
  const analysis = await request('/api/analysis/main-business?company=sz&period=2027-02&year=2027');
  assert.equal(analysis.response.status, 200);
  assert.equal(analysis.payload.detailRows.find(row => row.contractNo === '20270220-2001').customerName, '客户甲');
  assert.equal(analysis.payload.detailRows.find(row => row.contractNo === '20270220-2002').customerName, '客户乙');
  assert.equal(analysis.payload.detailRows.find(row => row.contractNo === '20270220-2001').cost, 0);
  assert.equal(analysis.payload.detailRows.find(row => row.contractNo === '20270220-2002').cost, 0);
  assert.equal(analysis.payload.detailRows.find(row => row.contractNo === '未识别合同').cost, 300);
});

test('广州二十列序时账按本币列驱动主营业务、费用、手续费和下钻金额', async () => {
  const header = ['日期', '凭证号', '摘要', '科目编码', '科目名称', '外币代码', '借方数量', '借方外币', '借方本币', '贷方数量', '贷方外币', '贷方本币', '客户编码', '客户名称', '部门编码', '部门名称', '制单人', '审核人', '附件数', '备注'];
  const entry = ({ row, voucher, summary, code, account, debit = 0, credit = 0, customer = '', department = '商务顾问部' }) => {
    const cells = Array(20).fill('');
    Object.assign(cells, { 0: '2027-05-10', 1: voucher, 2: summary, 3: code, 4: account, 8: debit, 11: credit, 13: customer, 15: department, 16: '会计002' });
    return { row, cells };
  };
  const journal = { sourceSheet: '5月序时账', maxRow: 9, maxCol: 20, rows: [
    { row: 1, cells: header },
    entry({ row: 2, voucher: '记-25', summary: '20270510-2001王炳几内亚比绍绿卡-读书，服务费16000元', code: '5001001', account: '主营业务收入-几内亚比绍绿卡-读书', credit: 16000 }),
    entry({ row: 3, voucher: '记-25', summary: '通联扫码收取服务费', code: '1002001', account: '银行存款-招商银行', debit: 16000 }),
    entry({ row: 4, voucher: '记-25', summary: '项目服务成本（摘要漏写订单号）', code: '5401001', account: '主营业务成本-几内亚比绍绿卡-读书', debit: 6000 }),
    entry({ row: 5, voucher: '记-25', summary: '收款手续费', code: '5603002', account: '财务费用-手续费', debit: 25 }),
    entry({ row: 6, voucher: '记-26', summary: '本月推广费', code: '5601006', account: '销售费用-广告费', debit: 1000 }),
    entry({ row: 7, voucher: '记-27', summary: '本月办公费', code: '5602004', account: '管理费用-办公费', debit: 500 }),
    entry({ row: 8, voucher: '记-28', summary: '利息支出', code: '5603001', account: '财务费用-利息支出', debit: 999 }),
    entry({ row: 9, voucher: '记-25', summary: '手续费冲减', code: '5603002', account: '财务费用-手续费', debit: -9 })
  ] };
  const uploaded = await post('/api/uploads', { companyKey: 'gz', period: '2027-05', reportType: 'journal', fileName: '2027.5广州桉侨序时账.json', fileType: 'application/json', contentBase64: Buffer.from(JSON.stringify({ journal })).toString('base64') });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  const batch = uploaded.payload.uploads?.[0] || uploaded.payload;
  assert.equal((await post(`/api/uploads/${batch.uploadKey}/publish`, {})).response.status, 200);

  const business = await request('/api/analysis/main-business?company=gz&period=2027-05&year=2027');
  assert.equal(business.response.status, 200);
  assert.equal(business.payload.current.revenue, 16000); assert.equal(business.payload.current.cost, 6000);
  assert.equal(business.payload.detailRows[0].contractNo, '20270510-2001');
  assert.equal(business.payload.detailRows[0].customerName, '王炳');
  assert.equal(business.payload.detailRows[0].projectName, '几内亚比绍绿卡-读书');
  assert.notEqual(business.payload.detailRows[0].projectName, '商务顾问部');

  const expenses = await request('/api/analysis/expenses?company=gz&period=2027-05&year=2027');
  assert.equal(expenses.response.status, 200);
  assert.equal(expenses.payload.selling.total, 1000); assert.equal(expenses.payload.administration.total, 500);
  assert.equal(expenses.payload.finance.rows.length, 1);
  assert.equal(expenses.payload.finance.rows[0].method, '通联扫码');
  assert.equal(expenses.payload.finance.rows[0].current, 16000); assert.equal(expenses.payload.finance.rows[0].fee, 16);

  const detail = await request(`/api/reports/journal/detail?company=gz&period=2027-05&search=${encodeURIComponent('主营业务收入')}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.payload.rawRows.find(row => row.row === 2).journal.credit, 16000);
  assert.equal(detail.payload.rawRows.find(row => row.row === 4).journal.debit, 6000);
  const cashDetail = await request(`/api/reports/balance_sheet/detail?company=gz&period=2027-05&search=${encodeURIComponent('货币资金')}`);
  assert.equal(cashDetail.response.status, 200);
  assert.equal(cashDetail.payload.rawRows.find(row => row.row === 3).journal.debit, 16000);
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  assert.match(frontend, /debit: \['借方金额', '借方本币'\]/);
  assert.match(frontend, /journalDisplayColumns\(raw\)/);
});

test('公司财务汇总文件内的报价单不会被误建为集团报单表批次', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '凭证号', '摘要', '科目编码', '科目名称', '借方本币', '贷方本币'],
    ['2027-06-30', '记-1', '测试收款', '1002001', '银行存款', 100, 0]
  ]), '6月序时账');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['合同编号', '客户姓名', '项目'], ['20270601-0001', '测试客户', '测试项目']
  ]), '报价单');
  const uploaded = await post('/api/uploads', { companyKey: 'gz', period: '2027-06', reportType: 'journal', fileName: '2027.6广州桉侨财务报表.xlsx', contentBase64: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }).toString('base64') });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  assert.deepEqual(uploaded.payload.uploads.map(item => item.reportType), ['journal']);
});

test('管理员可复制员工权限范围，普通员工不能复制', async () => {
  const copied = await post('/api/admin/copy-employee-permissions', { sourceEmployeeKey: 'accountant', targetEmployeeKey: 'viewer' });
  assert.equal(copied.response.status, 200);
  assert.deepEqual(copied.payload.roleKeys, ['accountant']);
  const targetDetail = await request('/api/reports/income_statement/detail?company=gz&period=2026-06', 'viewer');
  assert.equal(targetDetail.response.status, 200);
  const forbidden = await post('/api/admin/copy-employee-permissions', { sourceEmployeeKey: 'accountant', targetEmployeeKey: 'viewer' }, 'manager');
  assert.equal(forbidden.response.status, 403);
});

test('地区总经理预设包含业务页面及其全部分析子模块并支持个人范围微调', async () => {
  const matrix = await request('/api/admin/roles');
  const preset = matrix.payload.roleDefaults.find(item => item.roleKey === 'regional_manager');
  assert.ok(preset);
  const expectedBase = ['module.cash_analysis.view', 'module.expense_analysis.view', 'module.financial_brief.view', 'module.main_business_analysis.view', 'report.balance_sheet.summary.view', 'report.cash_flow.summary.view', 'report.income_statement.summary.view'];
  expectedBase.forEach(key => assert.ok(preset.permissionKeys.includes(key)));
  ['net_positions', 'cash_accounts', 'other_liquidity', 'core_liquidity_trend'].forEach(block => assert.ok(preset.permissionKeys.includes(`module.cash_analysis.${block}.view`)));
  ['business_detail', 'project_change', 'gross_trend'].forEach(block => assert.ok(preset.permissionKeys.includes(`module.main_business_analysis.${block}.view`)));
  ['selling_table', 'selling_share', 'selling_trend', 'admin_table', 'admin_share', 'admin_trend', 'finance_table', 'finance_share', 'finance_methods'].forEach(block => assert.ok(preset.permissionKeys.includes(`module.expense_analysis.${block}.view`)));
  assert.ok(matrix.payload.permissionCatalog.some(group => group.id === 'reports'));

  const saved = await post('/api/admin/employee-permission-profile', {
    employeeKey: 'regional_gm', presetRoleKey: 'regional_manager', permissionKeys: preset.permissionKeys,
    companyKeys: ['gz'], fromPeriod: '2026-01', toPeriod: '2026-12', accountVisibility: 'level1', showDirection: false, showFullEntry: false
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.payload.profile.isCustomized, true);

  const navigation = await request('/api/bootstrap?company=gz&period=2026-06', 'regional_gm');
  assert.deepEqual(navigation.payload.modules.map(item => item.key), ['home', 'financial_brief', 'balance_sheet', 'income_statement', 'cash_flow', 'cash_analysis', 'main_business_analysis', 'expense_analysis']);
  const allowedAnalysis = await request('/api/analysis/main-business?company=gz&period=2026-07', 'regional_gm');
  assert.equal(allowedAnalysis.response.status, 200);
  const deniedCompany = await request('/api/reports/income_statement/summary?company=sz&period=2026-06', 'regional_gm');
  assert.equal(deniedCompany.response.status, 403);
});

test('企微通讯录搜索和员工完整权限复制均受管理员保护', async () => {
  const directory = await request('/api/admin/directory-employees?search=张总');
  assert.equal(directory.response.status, 200);
  assert.deepEqual(directory.payload.employees.map(item => item.name), ['地区总经理张总']);
  const forbiddenDirectory = await request('/api/admin/directory-employees?search=张总', 'manager');
  assert.equal(forbiddenDirectory.response.status, 403);

  const copied = await post('/api/admin/copy-employee-permissions', { sourceEmployeeKey: 'regional_gm', targetEmployeeKey: 'new_employee' });
  assert.equal(copied.response.status, 200);
  assert.equal(copied.payload.profile.presetRoleKey, 'regional_manager');
  assert.deepEqual(copied.payload.profile.companyKeys, ['gz']);
  assert.equal(copied.payload.profile.showDirection, false);
});

test('管理员可移除已添加员工授权但保留通讯录人员，且不能移除自己', async () => {
  const assigned = await post('/api/admin/copy-employee-permissions', { sourceEmployeeKey: 'regional_gm', targetEmployeeKey: 'new_employee' });
  assert.equal(assigned.response.status, 200); assert.equal(assigned.payload.profile.hasAssignment, true);
  const removed = await remove('/api/admin/employee-permission-profile', { employeeKey: 'new_employee' });
  assert.equal(removed.response.status, 200); assert.equal(removed.payload.profile.hasAssignment, false); assert.deepEqual(removed.payload.profile.permissionKeys, []); assert.deepEqual(removed.payload.profile.companyKeys, []);
  const unconfigured = await request('/api/bootstrap?company=gz&period=2026-06', 'new_employee');
  assert.deepEqual(unconfigured.payload.companies, []); assert.deepEqual(unconfigured.payload.modules.map(item => item.key), ['home']);
  const directory = await request(`/api/admin/directory-employees?search=${encodeURIComponent('新员工王经理')}`);
  assert.deepEqual(directory.payload.employees.map(item => item.name), ['新员工王经理']);
  const selfRemoval = await remove('/api/admin/employee-permission-profile', { employeeKey: 'admin' });
  assert.equal(selfRemoval.response.status, 400);
  const forbidden = await remove('/api/admin/employee-permission-profile', { employeeKey: 'new_employee' }, 'manager');
  assert.equal(forbidden.response.status, 403);
});

test('管理员不能在当前会话中移除自己的权限管理能力', async () => {
  const matrix = await request('/api/admin/roles'); const preset = matrix.payload.roleDefaults.find(item => item.roleKey === 'admin');
  const rejected = await post('/api/admin/employee-permission-profile', { employeeKey: 'admin', presetRoleKey: 'admin', permissionKeys: preset.permissionKeys.filter(key => key !== 'module.permissions.manage'), companyKeys: ['*'], fromPeriod: '2020-01', toPeriod: '2099-12', accountVisibility: 'full', showDirection: true, showFullEntry: true });
  assert.equal(rejected.response.status, 400);
});

test('一份汇总文件可自动拆分正式报表与隐藏科目余额表', async () => {
  const bundle = {
    balance_sheet: { sourceSheet: '资产负债表', rows: [{ row: 1, cells: ['项目', '期末余额'] }, { row: 2, cells: ['货币资金', 100] }] },
    income_statement: { sourceSheet: '利润表', rows: [{ row: 1, cells: ['项目', '本期金额'] }, { row: 2, cells: ['营业收入', 200] }] },
    cash_flow: { sourceSheet: '现金流量表-钱去向', rows: [{ row: 1, cells: ['项目', '本期金额'] }, { row: 2, cells: ['经营活动现金流', 80] }] },
    trial_balance: { sourceSheet: '7月科目余额表', hidden: true, rows: [{ row: 1, cells: ['科目编码', '科目名称', '期末余额'] }, { row: 2, cells: ['1002', '银行存款', 100] }] },
    journal: { sourceSheet: '7月序时账', hidden: true, rows: [{ row: 1, cells: ['凭证号', '摘要'] }, { row: 2, cells: ['记-1', '测试'] }] }
  };
  const uploaded = await post('/api/uploads', { companyKey: 'gz', period: '2026-09', fileName: '2026.09 汇总财务报表.json', fileType: 'application/json', contentBase64: Buffer.from(JSON.stringify(bundle)).toString('base64') });
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.payload.uploads.length, 5);
  assert.deepEqual(uploaded.payload.uploads.map(item => item.reportType).sort(), ['balance_sheet', 'cash_flow', 'income_statement', 'journal', 'trial_balance']);
  assert.equal(uploaded.payload.sheets.find(item => item.reportType === 'trial_balance')?.hidden, true);
  assert.equal(uploaded.payload.sheets.find(item => item.reportType === 'journal')?.hidden, true);
});

test('上传请求缺失或失效字段时返回明确字段并由前端阻止空文件提交', async () => {
  const contentBase64 = Buffer.from('{"uploaded":true}').toString('base64');
  const cases = [
    [{ period: '2026-07', fileName: '测试.json', contentBase64 }, 'companyKey', /未选择上传公司/],
    [{ companyKey: 'missing-company', period: '2026-07', fileName: '测试.json', contentBase64 }, 'companyKey', /上传公司不存在或已失效/],
    [{ companyKey: 'group', fileName: '测试.json', contentBase64 }, 'period', /未选择报表期间/],
    [{ companyKey: 'group', period: '2026/07', fileName: '测试.json', contentBase64 }, 'period', /报表期间格式无效/],
    [{ companyKey: 'group', period: '2026-07', reportType: 'missing-report', fileName: '测试.json', contentBase64 }, 'reportType', /报表类型不存在或已失效/],
    [{ companyKey: 'group', period: '2026-07', contentBase64 }, 'fileName', /未传入文件名称/],
    [{ companyKey: 'group', period: '2026-07', fileName: '测试.json', contentBase64: '' }, 'contentBase64', /未传入文件内容，请重新选择文件/]
  ];
  for (const [body, field, message] of cases) {
    const result = await post('/api/uploads', body);
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.code, 'UPLOAD_REQUEST_INVALID');
    assert.ok(result.payload.fields.includes(field));
    assert.match(result.payload.error, message);
  }

  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  assert.match(frontend, /page\.querySelectorAll\('\[data-slot-choose\]'\)/);
  assert.match(frontend, /page\.querySelectorAll\('\.slot-input'\)/);
  assert.match(frontend, /file\.size\) \|\| file\.size <= 0/);
  assert.match(frontend, /浏览器未能读取文件内容，请重新选择文件后再试/);
  assert.match(frontend, /state\.bootstrap\.companies\.some\(company => company\.key === companyKey\)/);
});

test('早期集团通用利润表名称按明确口径识别且不混入公司利润表', async () => {
  for (const [reportType, fileName] of [
    ['consolidated_income_statement', '2027.06桉侨集团合并利润表.xlsx'],
    ['revenue_profit_consolidated_income_statement', '（营收利润口径）2027.06桉侨集团合并利润表.xlsx']
  ]) {
    const uploaded = await post('/api/uploads', {
      companyKey: 'group', period: '2027-06', reportType, fileName,
      contentBase64: legacyGroupWorkbookBuffer(reportType).toString('base64')
    });
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
    assert.deepEqual(uploaded.payload.uploads.map(item => item.reportType), [reportType]);
    assert.equal(uploaded.payload.sheets[0].sourceSheet, '利润表');
    assert.equal(uploaded.payload.sheets.some(item => item.reportType === 'income_statement'), false);
  }
  const mainOnly = await post('/api/uploads', {
    companyKey: 'group', period: '2027-05', reportType: 'consolidated_income_statement', fileName: '2027.05桉侨集团合并利润表.xlsx',
    contentBase64: legacyGroupMainOnlyWorkbookBuffer().toString('base64')
  });
  assert.equal(mainOnly.response.status, 201, JSON.stringify(mainOnly.payload));
  const preview = await request(`/api/reports/consolidated_income_statement/raw?company=group&period=2027-05&uploadKey=${mainOnly.payload.uploadKey}`);
  assert.equal(preview.payload.raw.reconciliationAvailable, false);
  assert.equal(preview.payload.raw.reconciliationPassed, null);
  assert.deepEqual(preview.payload.raw.entities, []);
});

test('早期通用工作表名工资文件按完整字段签名识别明细页', async () => {
  const uploaded = await post('/api/uploads', {
    companyKey: 'group', period: '2027-06', reportType: 'payroll_statement', fileName: '2027年6月桉侨集团工资表.xlsx',
    contentBase64: genericPayrollWorkbookBuffer().toString('base64')
  });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  assert.deepEqual(uploaded.payload.uploads.map(item => item.reportType), ['payroll_statement']);
  assert.equal(uploaded.payload.sheets[0].sourceSheet, 'Sheet1');
});

test('汇总文件排除错月序时账和科目余额表并返回逐表诊断', async () => {
  const contentBase64 = bundleWithStaleLedgerSourcesBuffer().toString('base64');
  const uploaded = await post('/api/uploads', { companyKey: 'gz', period: '2027-08', fileName: '2027.08广州桉侨汇总财务报表.xlsx', contentBase64 });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  assert.deepEqual(uploaded.payload.uploads.map(item => item.reportType), ['income_statement']);
  assert.deepEqual(uploaded.payload.periodExcludedReports.map(item => item.reportType).sort(), ['journal', 'trial_balance']);
  assert.deepEqual(uploaded.payload.periodExcludedReports.find(item => item.reportType === 'journal').detectedPeriods, ['2027-07']);
  assert.deepEqual(uploaded.payload.periodExcludedReports.find(item => item.reportType === 'trial_balance').detectedPeriods, ['2027-07']);

  const rejected = await post('/api/uploads', { companyKey: 'gz', period: '2027-08', reportType: 'journal', fileName: '2027.08广州桉侨序时账.xlsx', contentBase64 });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.payload.code, 'REPORT_PERIOD_EXCLUDED');
  assert.deepEqual(rejected.payload.periodExcludedReports.map(item => item.reportType).sort(), ['journal', 'trial_balance']);
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  assert.match(frontend, /periodExcludedReports/);
  assert.match(frontend, /因期间不符未生成/);
});

test('桉侨集团合并利润表独立识别、勾稽并只在集团范围展示', async () => {
  const contentBase64 = consolidatedWorkbookBuffer().toString('base64');
  const wrongCompany = await post('/api/uploads', { companyKey: 'gz', period: '2026-07', reportType: 'consolidated_income_statement', fileName: '2026.7桉侨集团合并利润表.xlsx', contentBase64 });
  assert.equal(wrongCompany.response.status, 409);
  assert.equal(wrongCompany.payload.code, 'COMPANY_MISMATCH');

  const uploaded = await post('/api/uploads', { companyKey: 'group', period: '2026-07', reportType: 'consolidated_income_statement', fileName: '2026.7桉侨集团合并利润表.xlsx', contentBase64 });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  assert.deepEqual(uploaded.payload.uploads.map(item => item.reportType), ['consolidated_income_statement']);
  assert.equal(uploaded.payload.sheets.find(item => item.reportType === 'consolidated_income_statement')?.sourceSheet, '集团利润表');

  const preview = await request(`/api/reports/consolidated_income_statement/raw?company=group&period=2026-07&uploadKey=${uploaded.payload.uploadKey}`);
  assert.equal(preview.response.status, 200);
  assert.equal(preview.payload.raw.rows.length, 36);
  assert.equal(preview.payload.raw.rows[2].cells[1], '2026年7月');
  assert.deepEqual(preview.payload.raw.entityNames, ['广州桉侨有限公司', '深圳桉侨移民服务有限公司']);
  assert.deepEqual(preview.payload.raw.entities.map(item => ({ sourceSheet: item.sourceSheet, companyName: item.companyName })), [
    { sourceSheet: '广州桉侨', companyName: '广州桉侨有限公司' },
    { sourceSheet: '深圳桉侨', companyName: '深圳桉侨移民服务有限公司' }
  ]);
  assert.equal(preview.payload.raw.entities.find(item => item.sourceSheet === '广州桉侨').rows[4].cells[3], 60);
  assert.equal(preview.payload.raw.reconciliationPassed, true);

  assert.equal((await post(`/api/uploads/${uploaded.payload.uploadKey}/publish`, {})).response.status, 200);
  const groupBootstrap = (await request('/api/bootstrap?company=group&period=2026-07')).payload;
  const expectedGroupModules = ['financial_brief', 'consolidated_income_statement', 'revenue_profit_consolidated_income_statement', 'group_profit_analysis', 'revenue_statistics', 'consultant_roi_analysis'];
  assert.deepEqual(groupBootstrap.modules.map(item => item.key).filter(key => expectedGroupModules.includes(key)), expectedGroupModules);
  assert.deepEqual(groupBootstrap.consolidatedEntities, [
    { sourceSheet: '广州桉侨', companyName: '广州桉侨有限公司' },
    { sourceSheet: '深圳桉侨', companyName: '深圳桉侨移民服务有限公司' }
  ]);
  assert.deepEqual(groupBootstrap.consolidatedEntitiesByReport.revenue_profit_consolidated_income_statement, []);
  assert.deepEqual((await request('/api/bootstrap?company=gz&period=2026-06')).payload.consolidatedEntities, []);
  assert.deepEqual(groupBootstrap.availablePeriodsByCompany.group, ['2026-07']);
  const summary = await request('/api/reports/consolidated_income_statement/summary?company=group&period=2026-07');
  assert.equal(summary.response.status, 200);
  assert.equal(summary.payload.lines.find(item => item.name === '一、营业收入').current, 100);
  const trends = await request('/api/analysis/group-profit-trends?company=group&period=2026-07&year=2026');
  assert.equal(trends.response.status, 200);
  assert.deepEqual(trends.payload.monthly.map(item => item.period), ['2026-07']);
  assert.deepEqual(trends.payload.monthly[0], {
    period: '2026-07', revenue: 100, cost: 50, sellingExpense: 18, administrationExpense: 9,
    financeExpense: 3, periodExpense: 30, netProfit: 50, version: 1, sourceName: '2026.7桉侨集团合并利润表.xlsx'
  });
  const historicalCutoff = await request('/api/analysis/group-profit-trends?company=group&period=2026-06&year=2026');
  assert.equal(historicalCutoff.response.status, 200); assert.equal(historicalCutoff.payload.source.noData, true); assert.deepEqual(historicalCutoff.payload.monthly, []);
  assert.equal((await request('/api/analysis/group-profit-trends?company=gz&period=2026-07&year=2026')).response.status, 400);
  assert.equal((await request('/api/analysis/group-profit-trends?company=group&period=2026-07&year=2026', 'viewer')).response.status, 403);

  const roles = (await request('/api/admin/roles')).payload;
  const reportGroup = roles.permissionCatalog.find(item => item.id === 'reports');
  assert.deepEqual(reportGroup.children.find(item => item.id === 'consolidated_income_statement').children.map(item => item.key), ['report.consolidated_income_statement.summary.view', 'report.consolidated_income_statement.summary.export']);
  assert.ok(roles.permissionCatalog.find(item => item.id === 'analysis').children.some(item => item.key === 'module.group_profit_analysis.view'));
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  assert.match(frontend, /renderConsolidatedIncomeStatement/);
  assert.match(frontend, /合并范围/);
  assert.match(frontend, /data-nav-submenu-for="\$\{escapeHtml\(module\.key\)\}"/);
  assert.match(frontend, /openConsolidatedEntity/);
  assert.match(frontend, /groupRaw\.entities[\s\S]*sourceSheet === state\.consolidatedEntitySheet/);
  assert.match(frontend, /集团文件内的子公司利润表/);
  assert.doesNotMatch(frontend, /selectedEntity[\s\S]{0,500}statementCell\(/);
  assert.match(frontend, /renderGroupProfitAnalysis/);
  assert.match(frontend, /营业收入和营业成本趋势图/);
  assert.match(frontend, /期间费用趋势图/);
  assert.match(frontend, /净利润趋势图/);
  assert.match(frontend, /applyAnalysisBlockLayout\(layout, 'group_profit_analysis'\)/);
  assert.match(frontend, /group-trend-scroll/);
  assert.match(frontend, /scroller\.scrollLeft = monthly\.length === 1/);
});

test('营收利润口径合并利润表展示至 H 列并沿用集团子公司下拉', async () => {
  const reportType = 'revenue_profit_consolidated_income_statement';
  const contentBase64 = revenueProfitWorkbookBuffer().toString('base64');
  const wrongCompany = await post('/api/uploads', { companyKey: 'gz', period: '2026-07', reportType, fileName: '（营收利润口径）2026.7桉侨集团合并利润表.xlsx', contentBase64 });
  assert.equal(wrongCompany.response.status, 409);

  const uploaded = await post('/api/uploads', { companyKey: 'group', period: '2026-07', reportType, fileName: '（营收利润口径）2026.7桉侨集团合并利润表.xlsx', contentBase64 });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  assert.deepEqual(uploaded.payload.uploads.map(item => item.reportType), [reportType]);
  assert.equal(uploaded.payload.sheets.find(item => item.reportType === reportType)?.sourceSheet, '营收口径集团利润表');
  assert.equal(uploaded.payload.sheets.find(item => item.reportType === reportType)?.columns, 7);

  const preview = await request(`/api/reports/${reportType}/raw?company=group&period=2026-07&uploadKey=${uploaded.payload.uploadKey}`);
  assert.equal(preview.response.status, 200);
  assert.equal(preview.payload.raw.rows.length, 36);
  assert.equal(preview.payload.raw.rows[2].cells[1], '2026年7月');
  assert.deepEqual(preview.payload.raw.rows[3].cells, ['项目', '行次', '本年累计金额', '本期金额', '当月调整数', '累计调整数', null]);
  assert.equal(preview.payload.raw.rows[14].cells[5], 120);
  assert.equal(preview.payload.raw.rows[14].cells[6], '补自有资源提成');
  assert.equal(preview.payload.raw.rows.some(row => row.cells.includes('辅助项目')), false);
  assert.deepEqual(preview.payload.raw.entities.map(item => ({ sourceSheet: item.sourceSheet, companyName: item.companyName })), [
    { sourceSheet: '广州桉侨', companyName: '广州桉侨有限公司' },
    { sourceSheet: '深圳桉侨', companyName: '深圳桉侨移民服务有限公司' }
  ]);
  assert.equal(preview.payload.raw.entities[0].rows[4].cells[3], 60);

  assert.equal((await post(`/api/uploads/${uploaded.payload.uploadKey}/publish`, {})).response.status, 200);
  const bootstrap = (await request('/api/bootstrap?company=group&period=2026-07')).payload;
  assert.deepEqual(bootstrap.consolidatedEntitiesByReport[reportType], [
    { sourceSheet: '广州桉侨', companyName: '广州桉侨有限公司' },
    { sourceSheet: '深圳桉侨', companyName: '深圳桉侨移民服务有限公司' }
  ]);
  assert.equal(bootstrap.modules.some(item => item.key === reportType), true);
  assert.equal((await request('/api/bootstrap?company=gz&period=2026-06')).payload.modules.some(item => item.key === reportType), false);
  const summary = await request(`/api/reports/${reportType}/summary?company=group&period=2026-07`);
  assert.equal(summary.response.status, 200);
  assert.equal(summary.payload.lines.find(item => item.name === '一、营业收入').current, 100);

  const roles = (await request('/api/admin/roles')).payload;
  const reportNode = roles.permissionCatalog.find(item => item.id === 'reports').children.find(item => item.id === reportType);
  assert.deepEqual(reportNode.children.map(item => item.key), [`report.${reportType}.summary.view`, `report.${reportType}.summary.export`]);
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  const renderer = frontend.slice(frontend.indexOf('function renderRevenueProfitConsolidatedStatement'), frontend.indexOf('function renderCashFlowStatement'));
  assert.match(renderer, /当月调整数/); assert.match(renderer, /累计调整数/); assert.match(renderer, /说明/);
  assert.match(renderer, /noteIndex = 6/); assert.match(renderer, /rowsThroughLastMatch/);
  assert.match(renderer, /plainStatementValue/); assert.doesNotMatch(renderer, /statementCell\(/);
  assert.match(renderer, /statementMeta\(raw, reportTitle, viewData, selectedEntity\?\.companyName\)/);
  assert.match(stylesheet, /\.revenue-profit-layout\{min-width:980px\}/);
});

test('集团营收统计表识别三维度八张子表并按集团权限发布', async () => {
  const reportType = 'revenue_statistics';
  const fileName = '2026年营收统计表26.7.xlsx';
  const contentBase64 = revenueStatisticsWorkbookBuffer().toString('base64');
  const wrongCompany = await post('/api/uploads', { companyKey: 'gz', period: '2026-07', reportType, fileName, contentBase64 });
  assert.equal(wrongCompany.response.status, 409);
  assert.equal(wrongCompany.payload.code, 'GROUP_COMPANY_REQUIRED');

  const uploaded = await post('/api/uploads', { companyKey: 'group', period: '2026-07', reportType, fileName, contentBase64 });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  assert.deepEqual(uploaded.payload.uploads.map(item => item.reportType), [reportType]);
  assert.equal(uploaded.payload.sheets.find(item => item.reportType === reportType)?.sourceSheet, '2026年数据统计汇总表（mia）');

  const preview = await request(`/api/reports/${reportType}/raw?company=group&period=2026-07&uploadKey=${uploaded.payload.uploadKey}`);
  assert.equal(preview.response.status, 200);
  assert.equal(preview.payload.raw.sourcePeriod, '2026-07');
  assert.deepEqual(preview.payload.raw.dimensions.map(item => item.key), ['group', 'direct', 'channel']);
  assert.deepEqual(preview.payload.raw.dimensions.map(item => item.tables.map(table => table.key)), [['B1', 'B2', 'B3'], ['B4', 'B5', 'B6'], ['B7', 'B8']]);
  const groupTables = preview.payload.raw.dimensions.find(item => item.key === 'group').tables;
  assert.equal(groupTables.find(item => item.key === 'B1').rows.length, 2);
  assert.equal(groupTables.find(item => item.key === 'B1').rows[0].cells[1], 4932629.50455);
  assert.equal(groupTables.find(item => item.key === 'B1').rows[0].cells[2], 239);
  assert.deepEqual(preview.payload.raw.cumulativeYears.map(item => item.year), ['2026']);
  const cumulativeTables = preview.payload.raw.cumulativeYears[0].tables;
  assert.deepEqual(cumulativeTables.map(item => item.key), ['L1', 'L2', 'L2-1', 'L3', 'L4', 'L5', 'L6']);
  assert.deepEqual(cumulativeTables.find(item => item.key === 'L1').headers, ['月份', '预计营收', '营收占比', '项目数量']);
  assert.equal(cumulativeTables.find(item => item.key === 'L1').titleRow, 13);
  assert.equal(cumulativeTables.find(item => item.key === 'L2').rows[1].cells[1], '202601');
  assert.deepEqual(preview.payload.raw.cumulativeIssues, []);
  assert.match(preview.payload.raw.note, /实际营收以集团口径为准/);
  assert.equal(preview.payload.raw.consultantRevenue.sourceSheet, '总营收明细表');
  assert.deepEqual(preview.payload.raw.consultantRevenue.rows.map(item => [item.canonicalName, item.region, item.expectedRevenue]), [
    ['詹志坚', '广州', 100000], ['张莎莎', '深圳', 80000], ['詹志坚', '广州', 20000], ['徐梓茵', '上海', 50000]
  ]);
  assert.equal(preview.payload.raw.consultantRevenue.selectedPeriod, '2026-07');
  assert.equal(preview.payload.raw.consultantRevenue.excludedPeriodRows, 1);
  assert.deepEqual(preview.payload.raw.consultantRevenue.fieldMapping, { consultant: '签约顾问/渠道', region: '业绩归属', expectedRevenue: '预计营收', period: '月份' });

  const rawPath = path.join(testUploadsDir, `${uploaded.payload.uploadKey.replace(/-revenue_statistics$/, '')}.json`);
  const legacyRaw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  delete legacyRaw.revenue_statistics.cumulativeYears; delete legacyRaw.revenue_statistics.cumulativeIssues;
  fs.writeFileSync(rawPath, JSON.stringify(legacyRaw), 'utf8');
  const refreshedLegacy = await request(`/api/reports/${reportType}/raw?company=group&period=2026-07&uploadKey=${uploaded.payload.uploadKey}`);
  assert.deepEqual(refreshedLegacy.payload.raw.cumulativeYears[0].tables.map(item => item.key), ['L1', 'L2', 'L2-1', 'L3', 'L4', 'L5', 'L6']);

  const legacyTitles = await post('/api/uploads', { companyKey: 'group', period: '2026-06', reportType, fileName: '2026年营收统计表26.6v1.xlsx', contentBase64: revenueStatisticsWorkbookBuffer('2026-06', true).toString('base64') });
  assert.equal(legacyTitles.response.status, 201, JSON.stringify(legacyTitles.payload));
  assert.equal(legacyTitles.payload.sheets.find(item => item.reportType === reportType)?.sourceSheet, '2026年数据统计汇总表（mia）');

  assert.equal((await post(`/api/uploads/${uploaded.payload.uploadKey}/publish`, {})).response.status, 200);
  const groupBootstrap = (await request('/api/bootstrap?company=group&period=2026-07')).payload;
  assert.equal(groupBootstrap.modules.some(item => item.key === reportType), true);
  assert.equal((await request('/api/bootstrap?company=gz&period=2026-06')).payload.modules.some(item => item.key === reportType), false);
  assert.equal((await request(`/api/reports/${reportType}/raw?company=group&period=2026-07`, 'accountant')).response.status, 403);

  const roles = (await request('/api/admin/roles')).payload;
  const permissionNode = roles.permissionCatalog.find(item => item.id === 'reports').children.find(item => item.id === reportType);
  assert.deepEqual(permissionNode.children.map(item => item.key), [`report.${reportType}.summary.view`, `report.${reportType}.summary.export`]);
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  assert.match(frontend, /renderRevenueStatistics/);
  assert.match(frontend, /data-revenue-dimension/);
  assert.match(frontend, /data-revenue-table/);
  assert.match(frontend, /data-revenue-cumulative-year/);
  assert.match(frontend, /data-revenue-cumulative-table/);
  assert.match(frontend, /{ key: 'cumulative', name: '营收统计累计数据' }/);
  assert.match(frontend, /state\.revenueDimension === 'cumulative'/);
  assert.match(frontend, /revenueCumulativeTabLabelHtml/);
  assert.match(frontend, /年度累计子表独立查看/);
  assert.match(frontend, /revenueStatisticsReportType, '集团营收统计表'/);
  assert.match(stylesheet, /\.revenue-dimension-switch/);
  assert.match(stylesheet, /\.revenue-table-scroll\{max-width:100%;overflow-x:auto/);
  assert.match(stylesheet, /\.revenue-cumulative-panel/);
  assert.match(stylesheet, /\.revenue-cumulative-tabs \.revenue-tab-label/);
});

test('集团顾问投入产出比联合工资表、营收明细和各公司序时账且保留来源', async () => {
  const period = '2027-03';
  const uploadAndPublish = async payload => {
    const uploaded = await post('/api/uploads', { period, ...payload });
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
    const batches = uploaded.payload.uploads || [uploaded.payload];
    for (const batch of batches) assert.equal((await post(`/api/uploads/${batch.uploadKey}/publish`, {})).response.status, 200);
    return batches;
  };

  const wrongMonthPayroll = await post('/api/uploads', {
    companyKey: 'group', period: '2027-04', reportType: 'payroll_statement', fileName: '2027年4月桉侨集团工资表.xlsx',
    contentBase64: payrollWorkbookBuffer().toString('base64')
  });
  assert.equal(wrongMonthPayroll.response.status, 400);
  assert.match(wrongMonthPayroll.payload.error, /未找到与所选期间 2027-04 对应的工资工作表/);
  assert.match(wrongMonthPayroll.payload.error, /202703工资表/);

  const payroll = await uploadAndPublish({
    companyKey: 'group', reportType: 'payroll_statement', fileName: '2027年3月桉侨集团工资表.xlsx',
    contentBase64: payrollWorkbookBuffer().toString('base64')
  });
  assert.equal(payroll[0].reportType, 'payroll_statement');
  const payrollPreview = await request(`/api/reports/payroll_statement/raw?company=group&period=${period}&uploadKey=${payroll[0].uploadKey}`);
  assert.equal(payrollPreview.response.status, 403);

  await uploadAndPublish({
    companyKey: 'group', reportType: 'revenue_statistics', fileName: '2027.3桉侨集团营收统计表.xlsx',
    contentBase64: revenueStatisticsWorkbookBuffer(period).toString('base64')
  });
  const spend = await uploadAndPublish({
    companyKey: 'group', reportType: 'consultant_spend_revenue', fileName: '27年3月顾问消耗-营收表.xlsx',
    contentBase64: consultantSpendWorkbookBuffer().toString('base64')
  });
  assert.equal(spend[0].reportType, 'consultant_spend_revenue');
  assert.equal((await request(`/api/reports/consultant_spend_revenue/raw?company=group&period=${period}&uploadKey=${spend[0].uploadKey}`)).response.status, 403);
  const automaticRefreshRequest = JSON.parse(fs.readFileSync(testConsultantDirectoryRefreshRequestFile, 'utf8'));
  assert.equal(automaticRefreshRequest.schemaVersion, 1); assert.equal(automaticRefreshRequest.reason, 'revenue_published');
  assert.deepEqual(Object.keys(automaticRefreshRequest).sort(), ['reason', 'requestId', 'requestedAt', 'schemaVersion']);
  const journalRows = rows => ({ journal: { sourceSheet: '3月序时账', rows: [
    { row: 1, cells: ['日期', '凭证号', '摘要', '科目编码', '科目名称', '借方金额', '贷方金额'] },
    ...rows
  ] } });
  await uploadAndPublish({
    companyKey: 'gz', reportType: 'journal', fileName: '2027.03广州桉侨序时账.json', fileType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify(journalRows([
      { row: 2, cells: ['2027-03-08', '记-001', '詹志坚客户拜访差旅', '5601001', '销售费用-差旅费', 3000, 0] },
      { row: 3, cells: ['2027-03-15', '记-002', '詹志坚3月工资', '5601002', '销售费用-工资', 10000, 0] },
      { row: 4, cells: ['2027-03-20', '记-003', '詹志坚与张莎莎联合活动', '5601003', '销售费用-活动费', 500, 0] },
      { row: 5, cells: ['2027-03-31', '记-099', '3月结转损益', '5601001', '销售费用-差旅费', 3000, 0] },
      { row: 6, cells: ['2027-03-31', '记-099', '', '4103001', '本年利润', 0, 3000] }
    ]))).toString('base64')
  });
  await uploadAndPublish({
    companyKey: 'sz', reportType: 'journal', fileName: '2027.03深圳桉侨序时账.json', fileType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify(journalRows([
      { row: 2, cells: ['2027-03-09', '记-011', '张莎莎客户招待', '5602001', '管理费用-业务招待费', 1200, 0] },
      { row: 3, cells: ['2027-03-18', '记-012', '张莎莎本月提成', '5601004', '销售费用-提成', 1500, 0] }
    ]))).toString('base64')
  });

  fs.writeFileSync(testConsultantDirectoryFile, JSON.stringify({ schemaVersion: 1, generatedAt: '2027-03-31T08:00:00.000Z', people: [
    { name: '詹志坚', englishName: 'James', employmentStatus: 'active' },
    { name: '张莎莎', englishName: 'Sasa', employmentStatus: 'resigned' },
    { name: '非顾问人员', englishName: 'Finance', employmentStatus: 'active' }
  ] }));
  fs.writeFileSync(testConsultantDirectoryStatusFile, JSON.stringify({ schemaVersion: 1, state: 'success', message: '企业微信花名册与通讯录已完成匹配', updatedAt: '2027-03-31T08:00:00.000Z', lastSuccessAt: '2027-03-31T08:00:00.000Z' }));
  fs.rmSync(testConsultantDirectoryRefreshRequestFile, { force: true });

  const result = await request(`/api/analysis/consultant-roi?company=group&period=${period}`);
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const byName = Object.fromEntries(result.payload.rows.map(item => [item.canonicalName, item]));
  assert.equal(result.payload.rows.some(item => ['当月计薪日', '147'].includes(item.name)), false);
  assert.deepEqual({ baseSalary: byName['詹志坚'].baseSalary, commission: byName['詹志坚'].commission, journalExpense: byName['詹志坚'].journalExpense, trafficSpend: byName['詹志坚'].trafficSpend, input: byName['詹志坚'].input, output: byName['詹志坚'].output, region: byName['詹志坚'].region, matchStatus: byName['詹志坚'].matchStatus }, { baseSalary: 10000, commission: 2000, journalExpense: 3000, trafficSpend: 26890.2, input: 41890.2, output: 120000, region: '广州', matchStatus: 'matched' });
  assert.ok(Math.abs(byName['詹志坚'].roi - 120000 / 41890.2) < 0.0000001);
  assert.deepEqual({ hireDate: byName['詹志坚'].hireDate, isNewEmployee: byName['詹志坚'].isNewEmployee }, { hireDate: '2027-03-05', isNewEmployee: true });
  assert.deepEqual({ englishName: byName['詹志坚'].englishName, isResigned: byName['詹志坚'].isResigned }, { englishName: 'James', isResigned: false });
  assert.deepEqual({ baseSalary: byName['张莎莎'].baseSalary, commission: byName['张莎莎'].commission, journalExpense: byName['张莎莎'].journalExpense, trafficSpend: byName['张莎莎'].trafficSpend, input: byName['张莎莎'].input, output: byName['张莎莎'].output, region: byName['张莎莎'].region }, { baseSalary: 9000, commission: 1500, journalExpense: 1200, trafficSpend: 21617.63, input: 33317.63, output: 80000, region: '深圳' });
  assert.equal(byName['徐梓茵'], undefined);
  assert.equal(byName['非顾问人员'], undefined);
  assert.equal(byName['张莎莎'].isNewEmployee, false);
  assert.deepEqual({ englishName: byName['张莎莎'].englishName, isResigned: byName['张莎莎'].isResigned }, { englishName: 'Sasa', isResigned: true });
  assert.equal(result.payload.rows.length, 2);
  assert.equal(result.payload.totals.input, 75207.83);
  assert.equal(result.payload.totals.trafficSpend, 48507.83);
  assert.equal(result.payload.totals.output, 200000);
  assert.equal(byName['詹志坚'].expenseDetails.length, 1);
  assert.match(byName['詹志坚'].expenseDetails[0].summary, /客户拜访/);
  assert.equal(byName['张莎莎'].expenseDetails.length, 1);
  assert.equal(byName['詹志坚'].payrollDetails[0].sourceSheet, '202703工资表');
  assert.deepEqual({ company: byName['詹志坚'].payrollDetails[0].company, department: byName['詹志坚'].payrollDetails[0].department, hireDate: byName['詹志坚'].payrollDetails[0].hireDate }, { company: '广州桉侨', department: '广州顾问部', hireDate: '2027-03-05' });
  assert.equal(byName['詹志坚'].revenueDetails.length, 2);
  assert.equal(byName['詹志坚'].spendDetails.length, 1);
  assert.deepEqual({ sourceSheet: byName['詹志坚'].spendDetails[0].sourceSheet, englishName: byName['詹志坚'].spendDetails[0].englishName, trafficSpend: byName['詹志坚'].spendDetails[0].trafficSpend }, { sourceSheet: '汇总', englishName: 'JAMES', trafficSpend: 26890.2 });
  assert.equal(result.payload.sources.payroll.fileName, '2027年3月桉侨集团工资表.xlsx');
  assert.equal(result.payload.sources.payrollSheet, '202703工资表');
  assert.deepEqual(result.payload.sources.payrollFields, { company: '公司', department: '部门', name: '中文姓名', hireDate: '入职日期', baseSalary: ['基本工资'], commission: '本月提成' });
  assert.equal(result.payload.sources.revenueSheet, '总营收明细表');
  assert.equal(result.payload.sources.spend.fileName, '27年3月顾问消耗-营收表.xlsx');
  assert.equal(result.payload.sources.spendSheet, '汇总');
  assert.deepEqual(result.payload.sources.spendFields, { englishName: '顾问（合并表头末列）', trafficSpend: '总消耗/元' });
  assert.deepEqual({ matched: result.payload.sources.matchedSpendRows, unmatched: result.payload.sources.unmatchedSpendRows, ambiguous: result.payload.sources.ambiguousSpendRows, unmatchedAmount: result.payload.sources.unmatchedSpendAmount }, { matched: 2, unmatched: 1, ambiguous: 0, unmatchedAmount: 9999 });
  assert.deepEqual(result.payload.sources.payrollConsultantDepartments, ['广州顾问部', '深圳顾问部']);
  assert.equal(result.payload.sources.payrollConsultantRows, 2);
  assert.equal(result.payload.sources.payrollExcludedRows, 1);
  assert.equal(result.payload.sources.revenueExcludedPeriodRows, 1);
  assert.equal(result.payload.sources.unmatchedRevenueRows, 1);
  assert.deepEqual({ available: result.payload.sources.directory.available, matchedRows: result.payload.sources.directory.matchedRows, generatedAt: result.payload.sources.directory.generatedAt }, { available: true, matchedRows: 2, generatedAt: '2027-03-31T08:00:00.000Z' });
  assert.equal(result.payload.sources.directory.sync.state, 'success');
  assert.match(result.payload.sourceRevision, /^[a-f0-9]{20}$/);

  fs.writeFileSync(testConsultantDirectoryFile, JSON.stringify({ schemaVersion: 1, generatedAt: '2027-03-31T09:00:00.000Z', people: [
    { name: '詹志坚', englishName: 'James', employmentStatus: 'active' }, { name: '张莎莎', englishName: 'Sasa', employmentStatus: 'active' }
  ] }));
  const directoryRefreshed = await request(`/api/analysis/consultant-roi?company=group&period=${period}`);
  assert.notEqual(directoryRefreshed.payload.sourceRevision, result.payload.sourceRevision);
  assert.equal(directoryRefreshed.payload.rows.find(item => item.canonicalName === '张莎莎').isResigned, false);

  await uploadAndPublish({
    companyKey: 'group', reportType: 'revenue_statistics', fileName: '2027.3桉侨集团营收统计表-修订版.xlsx',
    contentBase64: revenueStatisticsWorkbookBuffer(period).toString('base64')
  });
  const refreshed = await request(`/api/analysis/consultant-roi?company=group&period=${period}`);
  assert.notEqual(refreshed.payload.sourceRevision, directoryRefreshed.payload.sourceRevision);

  const manualRefresh = await post('/api/analysis/consultant-directory/refresh', { companyKey: 'group', period });
  assert.equal(manualRefresh.response.status, 202); assert.equal(manualRefresh.payload.requested, true); assert.equal(manualRefresh.payload.sync.state, 'pending');
  const manualRefreshRequest = JSON.parse(fs.readFileSync(testConsultantDirectoryRefreshRequestFile, 'utf8'));
  assert.equal(manualRefreshRequest.reason, 'manual'); assert.doesNotMatch(JSON.stringify(manualRefreshRequest), /詹志坚|张莎莎|工资|营收/);
  const pendingDirectory = await request(`/api/analysis/consultant-roi?company=group&period=${period}`);
  assert.equal(pendingDirectory.payload.sources.directory.sync.state, 'pending');
  assert.equal((await post('/api/analysis/consultant-directory/refresh', { companyKey: 'group', period }, 'accountant')).response.status, 403);

  fs.rmSync(testConsultantDirectoryRefreshRequestFile, { force: true });
  const authUrl = 'https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=Finance_test_123';
  const authUrlExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  fs.writeFileSync(testConsultantDirectoryStatusFile, JSON.stringify({ schemaVersion: 1, state: 'auth_required', message: '企业微信授权已到期', updatedAt: new Date().toISOString(), lastSuccessAt: '2027-03-31T09:00:00.000Z', authUrl, authUrlExpiresAt }));
  const adminAuthorizationView = await request(`/api/analysis/consultant-roi?company=group&period=${period}`);
  assert.equal(adminAuthorizationView.payload.canManageAuthorization, true);
  assert.deepEqual({ authUrl: adminAuthorizationView.payload.sources.directory.sync.authUrl, authUrlExpiresAt: adminAuthorizationView.payload.sources.directory.sync.authUrlExpiresAt }, { authUrl, authUrlExpiresAt });
  const managerAuthorizationView = await request(`/api/analysis/consultant-roi?company=group&period=${period}`, 'manager');
  assert.equal(managerAuthorizationView.response.status, 200);
  assert.equal(managerAuthorizationView.payload.canManageAuthorization, false);
  assert.equal(managerAuthorizationView.payload.sources.directory.sync.authUrl, undefined);
  assert.equal((await post('/api/analysis/consultant-directory/authorize', {}, 'manager')).response.status, 403);
  const authorizationRequest = await post('/api/analysis/consultant-directory/authorize', {});
  assert.equal(authorizationRequest.response.status, 202); assert.equal(authorizationRequest.payload.requested, true);
  const authorizationRequestFile = JSON.parse(fs.readFileSync(testConsultantDirectoryAuthRequestFile, 'utf8'));
  assert.equal(authorizationRequestFile.reason, 'manual_reauthorization'); assert.doesNotMatch(JSON.stringify(authorizationRequestFile), /Finance_test_123|詹志坚|张莎莎/);

  fs.writeFileSync(testConsultantDirectoryStatusFile, JSON.stringify({ schemaVersion: 1, state: 'auth_required', message: '企业微信授权已到期', updatedAt: new Date().toISOString(), lastSuccessAt: '', authUrl, authUrlExpiresAt: '2020-01-01T00:00:00.000Z' }));
  const expiredAuthorizationView = await request(`/api/analysis/consultant-roi?company=group&period=${period}`);
  assert.equal(expiredAuthorizationView.payload.sources.directory.sync.authUrl, undefined);

  fs.writeFileSync(testConsultantDirectoryFile, 'x'.repeat(513 * 1024));
  const rejectedDirectory = await request(`/api/analysis/consultant-roi?company=group&period=${period}`);
  assert.equal(rejectedDirectory.response.status, 200);
  assert.equal(rejectedDirectory.payload.sources.directory.available, false);
  assert.match(rejectedDirectory.payload.sources.directory.reason, /大小异常/);
  assert.equal(rejectedDirectory.payload.rows.find(item => item.canonicalName === '詹志坚').englishName, '');

  assert.equal((await request(`/api/analysis/consultant-roi?company=gz&period=${period}`)).response.status, 400);
  assert.equal((await request(`/api/analysis/consultant-roi?company=group&period=${period}`, 'accountant')).response.status, 403);
  const groupBootstrap = (await request(`/api/bootstrap?company=group&period=${period}`)).payload;
  const companyBootstrap = (await request(`/api/bootstrap?company=gz&period=${period}`)).payload;
  assert.equal(groupBootstrap.modules.some(item => item.key === 'consultant_roi_analysis'), true);
  assert.equal(companyBootstrap.modules.some(item => item.key === 'consultant_roi_analysis'), false);
  const permissionCatalog = (await request('/api/admin/roles')).payload.permissionCatalog;
  assert.ok(permissionCatalog.find(item => item.id === 'analysis').children.some(item => item.key === 'module.consultant_roi_analysis.view'));
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  const serverSource = fs.readFileSync(path.join(projectDir, 'app.mjs'), 'utf8');
  const directorySyncSource = fs.readFileSync(path.join(projectDir, 'deploy', 'sync-consultant-directory.mjs'), 'utf8');
  const directoryAuthSource = fs.readFileSync(path.join(projectDir, 'deploy', 'init-consultant-directory-auth.mjs'), 'utf8');
  const directoryAuthUnit = fs.readFileSync(path.join(projectDir, 'deploy', 'systemd', 'wecom-finance-consultant-auth.service'), 'utf8');
  assert.match(frontend, /data-roi-input/); assert.match(frontend, /data-roi-filter-toggle/); assert.match(frontend, /data-roi-filter-draft/); assert.match(frontend, /data-roi-sort/);
  assert.match(frontend, /consultant-roi-filter-menu/); assert.match(frontend, /positionColumnFilter/); assert.doesNotMatch(frontend, /roi-filter-row/);
  assert.match(frontend, /consultant-roi-export/); assert.match(frontend, /顾问投入产出比\.csv/);
  assert.match(frontend, /key: 'trafficSpend', label: '投流消耗费用'/); assert.match(frontend, /consultantSpendRevenueReportType, '集团顾问消耗-营收表'/);
  assert.match(frontend, /投流取数字段/); assert.match(frontend, /unmatchedSpendRows/);
  assert.match(frontend, /工资取数字段/); assert.match(frontend, /payrollFields/);
  assert.match(serverSource, /refreshedConsultantPayrollRawFor/); assert.match(serverSource, /hireDate\.slice\(0, 7\) === period/);
  assert.match(frontend, /consultantRoiAverageSummary/); assert.match(frontend, /consultant-roi-average-modal/); assert.match(frontend, /consultant-new-hire-badge/); assert.match(frontend, /入职时间/);
  assert.match(frontend, /key: 'hireDate', label: '入职日期'/); assert.match(frontend, /key: 'englishName', label: '英文名'/); assert.match(frontend, /consultant-resigned-badge/);
  assert.match(serverSource, /consultantDirectorySnapshot/); assert.match(serverSource, /directory: directory\.revision/); assert.match(serverSource, /employmentStatus === 'resigned'/);
  assert.match(directorySyncSource, /contact', 'users', 'search/); assert.match(directorySyncSource, /sheet', 'get', '--json/); assert.match(directorySyncSource, /sheet', 'ranges', 'get', '--json/); assert.match(directorySyncSource, /mode: 'default'/); assert.match(directorySyncSource, /exactTwoColumnRows/); assert.doesNotMatch(directorySyncSource, /WECOM_ALLOW_WIDE_ROSTER_READ/);
  assert.match(directorySyncSource, /schemaVersion: 1/); assert.match(directorySyncSource, /englishName: contactNames\.get\(key\) \|\| roster\?\.englishName/);
  assert.match(directorySyncSource, /AUTH_REQUIRED/); assert.match(directorySyncSource, /source_permission_required/); assert.match(directorySyncSource, /CONSULTANT_DIRECTORY_STATUS_FILE/); assert.match(directorySyncSource, /CONSULTANT_DIRECTORY_AUTH_REQUEST_FILE/);
  assert.match(directoryAuthSource, /auth', 'init', '--noninteractive/); assert.match(directoryAuthSource, /work\.weixin\.qq\.com/); assert.match(directoryAuthSource, /authUrlExpiresAt/); assert.doesNotMatch(directoryAuthSource, /console\.log/);
  assert.match(directoryAuthUnit, /WECOM_CLI=\/opt\/wecom-finance\/wecom-cli/); assert.match(directoryAuthUnit, /HOME=\/var\/lib\/wecom-finance-cli/); assert.match(directoryAuthUnit, /ProtectHome=true/);
  assert.match(serverSource, /CONSULTANT_DIRECTORY_REFRESH_REQUEST_FILE/); assert.match(serverSource, /CONSULTANT_DIRECTORY_AUTH_REQUEST_FILE/); assert.match(serverSource, /consultantDirectoryRefreshForPublishedReports/); assert.match(serverSource, /consultant-directory\/refresh/); assert.match(serverSource, /consultant-directory\/authorize/);
  assert.match(frontend, /consultantRoiAutoRefreshMs = 60_000/); assert.match(frontend, /consultant-roi-refresh/); assert.match(frontend, /data\.sourceRevision === consultantRoiSourceRevision/);
  assert.match(frontend, /consultantDirectoryPollingMs = 3_000/); assert.match(frontend, /consultant-directory-guide-modal/); assert.match(frontend, /consultant-directory-auth-link/); assert.match(frontend, /consultant-directory-auth-request/);
  assert.match(frontend, /state\.page === consultantRoiModuleKey[\s\S]{0,180}renderConsultantRoiInteractive\(\{ trigger: 'resume' \}\)/);
  assert.match(frontend, /visibleColumns = consultantRoiColumns\.filter/); assert.match(frontend, /selectedInputs\.map\(item => item\.label\)/);
  assert.match(stylesheet, /\.consultant-roi-layout>\[data-analysis-block\]\{grid-column:span 12\}/);
  assert.match(stylesheet, /analysis-layout-editable>\.consultant-roi-table-panel \.consultant-roi-table-toolbar\{padding-right:78px\}/);
  assert.match(stylesheet, /\.consultant-roi-page-actions\{[^}]*flex-wrap:nowrap/); assert.match(stylesheet, /#consultant-roi-refresh-status\{[^}]*position:absolute/);
  assert.match(stylesheet, /\.consultant-roi-average-card/); assert.match(stylesheet, /\.consultant-roi-average-modal/); assert.match(stylesheet, /\.consultant-new-hire-badge/);
  assert.match(stylesheet, /\.consultant-resigned-badge/); assert.match(stylesheet, /roi-col-hireDate/); assert.match(stylesheet, /roi-col-englishName/); assert.match(stylesheet, /roi-col-trafficSpend/);
  assert.match(stylesheet, /\.consultant-directory-guide/); assert.match(stylesheet, /\.consultant-directory-guide-modal/); assert.match(stylesheet, /\.consultant-directory-auth-actions/);
  assert.match(stylesheet, /\.consultant-roi-table\{width:100%;min-width:0!important;table-layout:fixed\}/);
  assert.match(stylesheet, /\.roi-filter-menu\{position:fixed/); assert.match(stylesheet, /\.roi-filter-trigger\.active/);
  const helperSource = frontend.slice(frontend.indexOf('const consultantRoiInputDefinitions'), frontend.indexOf('async function renderConsultantRoiAnalysis'));
  assert.doesNotMatch(helperSource, /label: '来源'/); assert.doesNotMatch(helperSource, /'匹配状态', '来源'/);
  const context = { result: null, summary: null, escapeHtml: value => String(value ?? ''), showNotice: () => {}, URL: {}, Blob: function Blob() {}, document: {}, window: {} };
  vm.runInNewContext(`const consultantRoiView = { inputs: { baseSalary: false, commission: true, journalExpense: true, trafficSpend: false }, filters: { region: '广州', input: '>=5000' }, sortKey: 'input', sortDirection: 'desc' }; ${helperSource}; const sampleRows = [{ name: '甲', region: '广州', baseSalary: 10000, commission: 2000, journalExpense: 3000, trafficSpend: 25000, output: 100000, matchStatus: 'matched', payrollDetails: [], revenueDetails: [], expenseDetails: [], spendDetails: [] }, { name: '乙', region: '深圳', baseSalary: 9000, commission: 1000, journalExpense: 500, trafficSpend: 12000, output: 80000, matchStatus: 'matched', payrollDetails: [], revenueDetails: [], expenseDetails: [], spendDetails: [] }]; result = consultantRoiRowsForView(sampleRows); summary = consultantRoiAverageSummary(sampleRows);`, context);
  assert.equal(context.result.length, 1); assert.equal(context.result[0].name, '甲'); assert.equal(context.result[0].input, 5000); assert.equal(context.result[0].roi, 20);
  assert.equal(context.summary.consultantCount, 2); assert.ok(Math.abs(context.summary.averageRoi - 36.6666666667) < 0.000001); assert.deepEqual(Array.from(context.summary.regions, item => item.region), ['广州', '深圳']);
});

test('财务数据简报按集团与公司范围联合已发布报表自动取数', async () => {
  const period = '2027-01';
  const publishJson = async ({ companyKey, reportType = '', fileName, reports }) => {
    const uploaded = await post('/api/uploads', { companyKey, period, reportType, fileName, fileType: 'application/json', contentBase64: Buffer.from(JSON.stringify(reports)).toString('base64') });
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
    for (const batch of uploaded.payload.uploads || [uploaded.payload]) assert.equal((await post(`/api/uploads/${batch.uploadKey}/publish`, {})).response.status, 200);
  };
  const incomeRows = values => [
    { row: 1, cells: ['项目', '行次', '本年累计金额', '本期金额'] },
    { row: 2, cells: ['一、营业收入', 1, 9000, values.revenue] },
    { row: 3, cells: ['减：营业成本', 2, 5000, values.cost] },
    { row: 4, cells: ['销售费用', 11, 1800, values.selling] },
    { row: 5, cells: ['管理费用', 14, 700, values.management] },
    { row: 6, cells: ['财务费用', 18, 90, values.finance] },
    { row: 7, cells: ['四、净利润（净亏损以“-”号填列）', 32, 2500, values.profit] }
  ];
  const nanjing = await post('/api/admin/companies', { name: '南京桉侨' });
  assert.equal(nanjing.response.status, 201);
  await publishJson({ companyKey: 'gz', fileName: '2027.01广州桉侨财务报表.json', reports: {
    balance_sheet: { sourceSheet: '资产负债表', rows: [{ row: 1, cells: ['项目', '期末余额', '年初余额'] }, { row: 2, cells: ['货币资金', 8083648.16, 7000000] }] },
    income_statement: { sourceSheet: '利润表', rows: incomeRows({ revenue: 3444225.54, cost: 1316926.56, selling: 1517788.23, management: 288193.79, finance: 9469.99, profit: 296833.51 }) },
    trial_balance: { sourceSheet: '1月科目余额表', rows: [
      { row: 1, cells: ['科目编码', '科目名称', '本期发生额', null] }, { row: 2, cells: [null, null, '借方', '贷方'] },
      { row: 3, cells: ['5601006', '广宣费', 400000, 100000] }, { row: 4, cells: ['5601016', '业务宣传费', 87814.94, 987.65] }
    ] }
  } });
  await publishJson({ companyKey: nanjing.payload.company.key, fileName: '2027.01南京桉侨财务报表.json', reports: {
    balance_sheet: { sourceSheet: '资产负债表', rows: [{ row: 1, cells: ['项目', '期末余额', '年初余额'] }, { row: 2, cells: ['货币资金', 1077204.66, 900000] }] },
    income_statement: { sourceSheet: '利润表', rows: incomeRows({ revenue: 601044.85, cost: 184243.08, selling: -8302.14, management: 17788, finance: 567.27, profit: 406133.81 }) },
    trial_balance: { sourceSheet: '1月科目余额表', rows: [
      { row: 1, cells: ['科目编码', '科目名称', '本期发生额', null] }, { row: 2, cells: [null, null, '借方', '贷方'] },
      { row: 3, cells: ['5601006', '广宣费', 0, 0] }
    ] }
  } });
  await publishJson({ companyKey: 'group', reportType: 'consolidated_income_statement', fileName: '2027.1桉侨集团合并利润表.json', reports: {
    consolidated_income_statement: { sourceSheet: '集团利润表', rows: incomeRows({ revenue: 7363026.77, cost: 3732291.37, selling: 2460172.83, management: 386239.17, finance: 11402.89, profit: 752554.03 }) }
  } });
  const revenueRows = (forecast, profit) => [
    { row: 1, cells: ['项目', '行次', '本年累计金额', '本期金额', '当月调整数', '累计调整数', '说明'] },
    { row: 2, cells: ['一、营业收入', 1, null, null, '当月营收利润', '累计营收利润', null] },
    { row: 3, cells: ['减：营业成本', 2, null, null, forecast, 27720846.34, null] },
    { row: 4, cells: ['四、净利润（净亏损以“-”号填列）', 32, 13054667.37, profit, null, null, null] }
  ];
  await publishJson({ companyKey: 'group', reportType: 'revenue_profit_consolidated_income_statement', fileName: '（营收利润口径）2027.1桉侨集团合并利润表.json', reports: {
    revenue_profit_consolidated_income_statement: { sourceSheet: '营收口径集团利润表', rows: revenueRows(4932629.50455, 2054448.11455), entities: [
      { sourceSheet: '广州桉侨', companyName: '广州桉侨有限公司', rows: revenueRows(1985248.4008, 154782.9308) },
      { sourceSheet: '南京桉侨', companyName: '南京桉侨移民服务有限公司', rows: revenueRows('657,147.15元', 406133.81) }
    ] }
  } });

  const group = await request(`/api/analysis/financial-brief?company=group&period=${period}`);
  assert.equal(group.response.status, 200); assert.equal(group.payload.scopeLabel, '集团方面');
  assert.deepEqual(group.payload.metrics, { expectedRevenue: 4932629.50455, accountBalance: 9160852.82, operatingRevenue: 7363026.77, operatingCost: 3732291.37, sellingExpense: 2460172.83, advertisingExpense: 487814.94, managementExpense: 386239.17, financeExpense: 11402.89, netProfit: 752554.03, comprehensiveRevenueProfit: 2054448.11455 });
  assert.equal(Object.hasOwn(group.payload, 'advertisingSources'), false);
  assert.equal(group.payload.sources.some(item => item.category === 'advertising'), false);
  const company = await request(`/api/analysis/financial-brief?company=gz&period=${period}`);
  assert.equal(company.response.status, 200); assert.equal(company.payload.metrics.expectedRevenue, 1985248.4008); assert.equal(company.payload.metrics.comprehensiveRevenueProfit, 154782.9308); assert.equal(company.payload.metrics.accountBalance, 8083648.16); assert.equal(company.payload.metrics.advertisingExpense, 487814.94);
  assert.equal(company.payload.canManageSecondaryItems, true); assert.deepEqual(company.payload.secondaryItems, []);
  const readOnlyProfile = await post('/api/admin/employee-permission-profile', { employeeKey: 'viewer', presetRoleKey: 'viewer', permissionKeys: ['module.financial_brief.view'], companyKeys: ['gz'], fromPeriod: period, toPeriod: period, accountVisibility: 'level1', showDirection: false, showFullEntry: false });
  assert.equal(readOnlyProfile.response.status, 200);
  const financeLeadProfile = await post('/api/admin/employee-permission-profile', { employeeKey: 'manager', presetRoleKey: 'manager', permissionKeys: ['module.financial_brief.view', 'module.financial_brief.notes.manage'], companyKeys: ['gz'], fromPeriod: period, toPeriod: period, accountVisibility: 'full', showDirection: true, showFullEntry: true });
  assert.equal(financeLeadProfile.response.status, 200);
  const viewerBrief = await request(`/api/analysis/financial-brief?company=gz&period=${period}`, 'viewer');
  assert.equal(viewerBrief.response.status, 200); assert.equal(viewerBrief.payload.canManageSecondaryItems, false);
  const forbiddenItem = await post('/api/analysis/financial-brief/secondary-items', { companyKey: 'gz', period, metricKey: 'expectedRevenue', text: '无权说明' }, 'viewer');
  assert.equal(forbiddenItem.response.status, 403);
  const rejectedResultItem = await post('/api/analysis/financial-brief/secondary-items', { companyKey: 'gz', period, metricKey: 'comprehensiveRevenueProfit', text: '不应新增' }, 'manager');
  assert.equal(rejectedResultItem.response.status, 400); assert.match(rejectedResultItem.payload.error, /营收综合利润不支持二级项目/);
  const rejectedEmpty = await post('/api/analysis/financial-brief/secondary-items', { companyKey: 'gz', period, metricKey: 'expectedRevenue', text: '   ' }, 'manager');
  assert.equal(rejectedEmpty.response.status, 400); assert.match(rejectedEmpty.payload.error, /二级说明应为 1 至 300 个字符/);
  const rejectedLong = await post('/api/analysis/financial-brief/secondary-items', { companyKey: 'gz', period, metricKey: 'expectedRevenue', text: '说'.repeat(301) }, 'manager');
  assert.equal(rejectedLong.response.status, 400); assert.match(rejectedLong.payload.error, /二级说明应为 1 至 300 个字符/);
  const createdItem = await post('/api/analysis/financial-brief/secondary-items', { companyKey: 'gz', period, metricKey: 'expectedRevenue', text: '  本月重点项目推进顺利，预计下月完成签约  ' }, 'manager');
  assert.equal(createdItem.response.status, 201); assert.equal(createdItem.payload.item.text, '本月重点项目推进顺利，预计下月完成签约'); assert.equal(createdItem.payload.item.amount, null);
  assert.equal((await put('/api/analysis/financial-brief/secondary-items', { itemKey: createdItem.payload.item.itemKey, text: '越权修改' }, 'viewer')).response.status, 403);
  assert.equal((await remove('/api/analysis/financial-brief/secondary-items', { itemKey: createdItem.payload.item.itemKey }, 'viewer')).response.status, 403);
  const updatedItem = await put('/api/analysis/financial-brief/secondary-items', { itemKey: createdItem.payload.item.itemKey, text: '本月新增签约 2 单，收入约 25.6 万元' });
  assert.equal(updatedItem.response.status, 200); assert.equal(updatedItem.payload.item.text, '本月新增签约 2 单，收入约 25.6 万元'); assert.equal(updatedItem.payload.item.amount, null);
  const withItem = await request(`/api/analysis/financial-brief?company=gz&period=${period}`, 'viewer');
  assert.equal(withItem.payload.secondaryItems.length, 1); assert.equal(withItem.payload.secondaryItems[0].metricKey, 'expectedRevenue'); assert.equal(withItem.payload.secondaryItems[0].text, '本月新增签约 2 单，收入约 25.6 万元');
  const nanjingBrief = await request(`/api/analysis/financial-brief?company=${nanjing.payload.company.key}&period=${period}`);
  assert.equal(nanjingBrief.response.status, 200); assert.equal(nanjingBrief.payload.metrics.expectedRevenue, 657147.15); assert.equal(nanjingBrief.payload.metrics.comprehensiveRevenueProfit, 406133.81); assert.equal(nanjingBrief.payload.metrics.accountBalance, 1077204.66);
  assert.ok(!nanjingBrief.payload.missing.some(item => item.includes('对应工作表') || item === '预计营收'));
  const roles = (await request('/api/admin/roles')).payload;
  const briefPermissions = roles.permissionCatalog.find(item => item.id === 'analysis').children.find(item => item.id === 'financial_brief_permissions');
  assert.ok(briefPermissions.children.some(item => item.key === 'module.financial_brief.view'));
  assert.equal(briefPermissions.children.find(item => item.key === 'module.financial_brief.notes.manage')?.name, '编辑二级说明');
  const bootstrap = (await request(`/api/bootstrap?company=gz&period=${period}`)).payload;
  assert.ok(bootstrap.modules.findIndex(item => item.key === 'financial_brief') < bootstrap.modules.findIndex(item => item.key === 'balance_sheet'));
  assert.equal(bootstrap.moduleOrder.findIndex(item => item.key === 'financial_brief') + 1, bootstrap.moduleOrder.findIndex(item => item.key === 'balance_sheet'));
  const missingAdvertising = await request(`/api/analysis/financial-brief?company=sz&period=${period}`);
  assert.equal(missingAdvertising.payload.metrics.advertisingExpense, null);
  assert.ok(missingAdvertising.payload.missing.some(item => item.startsWith('广宣费来源缺少：') && item.endsWith('（科目余额表）')));
  assert.doesNotMatch(missingAdvertising.payload.missing.join('；'), /序时账/);
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const backend = fs.readFileSync(path.join(projectDir, 'app.mjs'), 'utf8');
  const advertisingHelper = backend.slice(backend.indexOf('const briefAdvertisingForCompany'), backend.indexOf('const financialBriefFor'));
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  assert.match(advertisingHelper, /amount: debitAmount/); assert.doesNotMatch(advertisingHelper, /rawReportFor\('journal'|creditAmount|借方－贷方/);
  assert.match(frontend, /renderFinancialBrief/); assert.match(frontend, /预计营收/); assert.match(frontend, /其中广宣费 \$\{value\(m\.advertisingExpense\)\}/);
  assert.match(frontend, /financial-brief-copy-button/); assert.match(frontend, /financialBriefPlainText/); assert.match(frontend, /class="financial-brief-item-add"[\s\S]*aria-label="在\$\{escapeHtml\(row\.label\)\}下添加二级说明"[\s\S]*>\+<\/button>/); assert.match(frontend, /\/api\/analysis\/financial-brief\/secondary-items/);
  const briefEditorSource = frontend.slice(frontend.indexOf('const openFinancialBriefItemEditor'), frontend.indexOf('const bindFinancialBriefActions'));
  assert.match(briefEditorSource, /maxlength="300"[^>]*aria-label="二级说明"[^>]*placeholder="自由填写说明文字"/); assert.doesNotMatch(briefEditorSource, /inputmode="decimal"|二级项目名称|二级项目金额/);
  assert.match(frontend, /financial-brief-item-delete/); assert.match(frontend, /确定删除二级说明/);
  assert.match(frontend, /row\.key !== 'comprehensiveRevenueProfit'/); assert.doesNotMatch(frontend, /class="financial-brief-note"|>备注</);
  assert.match(frontend, /financialBriefAutoRefreshMs = 60_000/); assert.match(frontend, /visibilitychange/); assert.match(frontend, /financial-brief-refresh/);
  assert.doesNotMatch(frontend, /广宣费来源明细|科目余额表优先、序时账兜底/); assert.doesNotMatch(stylesheet, /\.financial-brief-advertising/); assert.match(stylesheet, /financial-brief-spin/);
  assert.match(stylesheet, /\.financial-brief-page-actions\{flex-wrap:nowrap\}/); assert.match(stylesheet, /\.financial-brief-refresh\{[^}]*white-space:nowrap/); assert.match(stylesheet, /#financial-brief-refresh-status\{[^}]*position:absolute/);
  assert.match(stylesheet, /\.financial-brief-copy-button/); assert.match(stylesheet, /\.financial-brief-subrow/); assert.match(stylesheet, /\.financial-brief-item-editor/);
  assert.match(stylesheet, /\.financial-brief-item-add\{position:absolute[^}]*left:-30px[^}]*opacity:0/); assert.match(stylesheet, /\.financial-brief-item-add\{top:21px\}/); assert.match(stylesheet, /\.financial-brief-subrow,\.financial-brief-item-editor\{grid-template-columns:minmax\(0,1fr\) auto\}/);
  assert.match(backend, /ALTER TABLE financial_brief_notes ADD COLUMN item_name/); assert.match(backend, /ALTER TABLE financial_brief_notes ADD COLUMN item_amount/);
  const plainTextSource = frontend.slice(frontend.indexOf('const financialBriefAmountText'), frontend.indexOf('const financialBriefRowsHtml'));
  const plainContext = {}; vm.runInNewContext(`${plainTextSource}; result = financialBriefPlainText(${JSON.stringify(withItem.payload)});`, plainContext);
  assert.doesNotMatch(plainContext.result, /\n\s*\n/); assert.match(plainContext.result, /预计营收 1,985,248\.40\n  本月新增签约 2 单，收入约 25\.6 万元\n账户余额/);
  const deletedItem = await remove('/api/analysis/financial-brief/secondary-items', { itemKey: createdItem.payload.item.itemKey }, 'manager');
  assert.equal(deletedItem.response.status, 200); assert.equal((await request(`/api/analysis/financial-brief?company=gz&period=${period}`)).payload.secondaryItems.length, 0);
  assert.match(frontend, /const nextModule = state\.bootstrap\.modules\.find\(item => item\.key === financialBriefModuleKey \|\| reportKeys\.has\(item\.key\)\)/);
  assert.doesNotMatch(frontend, /const nextModule = state\.bootstrap\.modules\.find\(item => item\.key !== 'home'\)/);
});

test('桌面宽内容不压缩左侧导航且移动端恢复横向模块栏', () => {
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  assert.match(stylesheet, /\.sidebar\{flex:0 0 228px;min-width:228px;max-width:228px\}/);
  assert.match(stylesheet, /\.content\{flex:1 1 auto;width:auto;min-width:0;max-width:1560px\}/);
  assert.match(stylesheet, /\.page,\.panel,\.card,\.card-grid,\.two-col,\.analysis-layout-grid,\.analysis-layout-block\{min-width:0;max-width:100%\}/);
  assert.match(stylesheet, /\.table-wrap,\.original-table-scroll\{min-width:0;max-width:100%;overflow-x:auto/);
  assert.match(stylesheet, /@media\(max-width:900px\)\{\s*\.sidebar\{flex:0 0 auto;width:100%;min-width:0;max-width:100vw\}/);
});

test('各公司往来校验按已登记经营公司自动扩展组合并严格隔离明细权限', async () => {
  const period = '2027-04'; const companies = await publishIntercompanyFixture(period);
  const summary = await request(`/api/analysis/intercompany-reconciliation?company=group&period=${period}`);
  assert.equal(summary.response.status, 200); const baselineCompanyCount = summary.payload.expectedCompanyCount;
  assert.ok(baselineCompanyCount >= 7); assert.equal(summary.payload.companyCount, baselineCompanyCount); assert.equal(summary.payload.combinationCount, baselineCompanyCount * (baselineCompanyCount - 1) / 2); assert.equal(summary.payload.metrics.coveredCompanies, 7); assert.equal(summary.payload.scopeComplete, true);
  const pairByRegions = (left, right) => summary.payload.pairs.find(pair => [pair.companyA.region, pair.companyB.region].includes(left) && [pair.companyA.region, pair.companyB.region].includes(right));
  assert.equal(pairByRegions('广州', '深圳').status.key, 'matched');
  assert.equal(pairByRegions('广州', '成都').status.key, 'one_sided');
  assert.equal(pairByRegions('广州', '南京').status.key, 'direction_conflict');
  assert.equal(pairByRegions('广州', '长沙').status.key, 'amount_mismatch');
  assert.equal(pairByRegions('广州', '青岛').status.key, 'direction_abnormal');
  assert.equal(pairByRegions('广州', '北京').status.key, 'unmapped');
  const matchedPair = pairByRegions('广州', '深圳');
  const pairDetail = await request(`/api/analysis/intercompany-reconciliation/pair?company=group&period=${period}&companyA=${matchedPair.companyA.key}&companyB=${matchedPair.companyB.key}`);
  assert.equal(pairDetail.response.status, 200); assert.equal(pairDetail.payload.canViewJournal, true);
  assert.equal(pairDetail.payload.journals[matchedPair.companyA.key].rows.length, 1); assert.equal(pairDetail.payload.journals[matchedPair.companyB.key].rows.length, 1);
  const unmapped = await request(`/api/analysis/intercompany-reconciliation/unmapped?company=group&period=${period}`);
  assert.equal(unmapped.response.status, 200); assert.match(unmapped.payload.rows.find(row => row.name.includes('办公室押金')).reason, /业务后缀/);
  assert.equal((await request(`/api/analysis/intercompany-reconciliation?company=group&period=${period}`, 'viewer')).response.status, 403);
  const createdShanghai = await post('/api/admin/companies', { name: '上海桉侨移民服务有限公司' });
  assert.equal(createdShanghai.response.status, 201); const shanghai = createdShanghai.payload.company;
  await publishIntercompanyCompany(shanghai, '上海', period, [{ code: '2202001', name: '广州桉侨移民咨询服务有限公司', debit: 0, credit: 25 }]);
  const expanded = await request(`/api/analysis/intercompany-reconciliation?company=group&period=${period}`);
  const expandedCompanyCount = baselineCompanyCount + 1;
  assert.equal(expanded.response.status, 200); assert.equal(expanded.payload.expectedCompanyCount, expandedCompanyCount); assert.equal(expanded.payload.companyCount, expandedCompanyCount); assert.equal(expanded.payload.combinationCount, expandedCompanyCount * (expandedCompanyCount - 1) / 2);
  assert.equal(expanded.payload.scopeComplete, true); assert.ok(expanded.payload.companies.some(company => company.key === shanghai.key && company.region === '上海'));
  const shanghaiPair = expanded.payload.pairs.find(pair => [pair.companyA.key, pair.companyB.key].includes(shanghai.key) && [pair.companyA.key, pair.companyB.key].includes(companies.get('广州').key));
  assert.equal(shanghaiPair.status.key, 'one_sided');
  await post('/api/admin/employee-permission-profile', {
    employeeKey: 'regional_gm', presetRoleKey: 'regional_manager', permissionKeys: ['module.intercompany_reconciliation.view'],
    companyKeys: ['group', companies.get('广州').key, companies.get('深圳').key], fromPeriod: '2027-01', toPeriod: '2027-12', accountVisibility: 'level1', showDirection: false, showFullEntry: false
  });
  const restricted = await request(`/api/analysis/intercompany-reconciliation?company=group&period=${period}`, 'regional_gm');
  assert.equal(restricted.response.status, 200); assert.equal(restricted.payload.companyCount, 2); assert.equal(restricted.payload.combinationCount, 1); assert.equal(restricted.payload.scopeComplete, false);
  assert.equal((await request(`/api/analysis/intercompany-reconciliation/pair?company=group&period=${period}&companyA=${companies.get('广州').key}&companyB=${companies.get('南京').key}`, 'regional_gm')).response.status, 404);
  const invalidChild = await post('/api/admin/employee-permission-profile', { employeeKey: 'regional_gm', presetRoleKey: 'regional_manager', permissionKeys: ['module.intercompany_reconciliation.detail'], companyKeys: ['*'], fromPeriod: '2027-01', toPeriod: '2027-12', accountVisibility: 'level1', showDirection: false, showFullEntry: false });
  assert.equal(invalidChild.response.status, 400); assert.match(invalidChild.payload.error, /先开启各公司往来校验浏览权限/);
  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8'); const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8'); const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  assert.match(frontend, /renderIntercompanyReconciliation[\s\S]*intercompany-reconciliation\/pair/); assert.match(frontend, /intercompany-only-exceptions/);
  assert.doesNotMatch(frontend, /class="card-grid intercompany-metrics"/); assert.match(frontend, /--intercompany-company-count/); assert.match(frontend, /\$\{companies\.length\} × \$\{companies\.length\} 往来校验矩阵/);
  assert.match(stylesheet, /\.intercompany-matrix\{[^}]*var\(--intercompany-company-count/); assert.match(stylesheet, /\.intercompany-source-list\{grid-template-columns:repeat\(auto-fit/); assert.match(html, /id="intercompany-reconciliation-page"/);
});

test('管理员浏览日志支持全员采集、多条件筛选和删除留痕', async () => {
  const adminBootstrap = await request('/api/bootstrap?company=gz&period=2026-06');
  const viewerBootstrap = await request('/api/bootstrap?company=gz&period=2026-06', 'viewer');
  assert.ok(adminBootstrap.payload.modules.some(item => item.key === 'activity_logs'));
  assert.ok(!viewerBootstrap.payload.modules.some(item => item.key === 'activity_logs'));
  assert.equal((await request('/api/admin/activity-logs', 'viewer')).response.status, 403);

  const viewed = await post('/api/activity/page-view', { moduleKey: 'home', companyKey: 'gz', period: '2026-06', detail: '首页' }, 'viewer');
  assert.equal(viewed.response.status, 200);
  assert.equal((await post('/api/activity/page-view', { moduleKey: 'permissions', companyKey: 'gz', period: '2026-06', detail: '越权页面' }, 'viewer')).response.status, 400);
  const logs = await request('/api/admin/activity-logs?employeeKey=viewer&logType=browse&moduleKey=home&period=2026-06&pageSize=10');
  assert.equal(logs.response.status, 200); assert.ok(logs.payload.total >= 1); assert.equal(logs.payload.stats.operation, 0);
  const item = logs.payload.items.find(row => row.action === 'browse_page' && row.employeeKey === 'viewer');
  assert.ok(item); assert.equal(item.actionName, '浏览页面'); assert.equal(item.companyName, '广州桉侨'); assert.equal(item.period, '2026-06');
  assert.ok(logs.payload.filters.employees.some(employee => employee.key === 'viewer'));

  const removed = await remove('/api/admin/activity-logs', { auditKeys: [item.auditKey] });
  assert.equal(removed.response.status, 200); assert.equal(removed.payload.removed, 1);
  const deletion = await request('/api/admin/activity-logs?action=delete_activity_logs&logType=operation&pageSize=10');
  assert.ok(deletion.payload.items.some(row => row.employeeKey === 'admin' && /removed=1/.test(row.detail)));
  assert.equal((await remove('/api/admin/activity-logs', { auditKeys: [] })).response.status, 400);

  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');
  assert.match(frontend, /renderActivityLogs/); assert.match(frontend, /recordCurrentPageView/); assert.match(frontend, /\/api\/admin\/activity-logs/);
  assert.match(stylesheet, /\.activity-log-filters/); assert.match(stylesheet, /\.activity-log-table/); assert.match(html, /id="activity-logs-page"/);
});

test('资产负债分析读取当前发布批次并在新版本发布后即时切换', async () => {
  const period = '2027-05';
  const analysisRaw = (sourceTotal, destinationTotal = sourceTotal) => ({
    balance_sheet: {
      sourceSheet: '资产负债表', maxRow: 9, maxCol: 13, rows: [
        { row: 1, cells: ['资产负债表'] },
        { row: 3, cells: ['项目', '期末余额', '年初余额', '负债和所有者权益（或股东权益）', '期末余额', '年初余额'] },
        { row: 4, cells: ['货币资金', destinationTotal, 80, '实收资本', sourceTotal, 80, '资产负债分析'] },
        { row: 5, cells: [null, null, null, null, null, null, '2027年负债、资产-钱的来源', null, null, null, '2027年钱的去向'] },
        { row: 6, cells: [null, null, null, null, null, null, '项目', null, '金额', null, '项目', null, '金额'] },
        { row: 7, cells: [null, null, null, null, null, null, '投资款', null, sourceTotal, null, '银行存款', null, destinationTotal] },
        { row: 8, cells: [null, null, null, null, null, null, '合计', null, sourceTotal, null, '合计', null, destinationTotal] }
      ]
    }
  });
  const uploadAndPublish = async (amount, versionName) => {
    const uploaded = await post('/api/uploads', { companyKey: 'gz', period, reportType: 'balance_sheet', fileName: `广州桉侨-${period}-资产负债表-${versionName}.json`, fileType: 'application/json', contentBase64: Buffer.from(JSON.stringify(analysisRaw(amount))).toString('base64') });
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
    const published = await post(`/api/uploads/${uploaded.payload.uploadKey}/publish`, {});
    assert.equal(published.response.status, 200, JSON.stringify(published.payload));
    return { uploadKey: uploaded.payload.uploadKey, version: published.payload.version };
  };

  const first = await uploadAndPublish(100, '第一版');
  const firstAnalysis = await request(`/api/reports/balance_sheet/analysis?company=gz&period=${period}`);
  assert.equal(firstAnalysis.response.status, 200); assert.equal(firstAnalysis.response.headers.get('cache-control'), 'no-store');
  assert.equal(firstAnalysis.payload.meta.uploadKey, first.uploadKey); assert.equal(firstAnalysis.payload.meta.version, first.version);
  assert.equal(firstAnalysis.payload.source.items[0].key, 'investment_funds'); assert.equal(firstAnalysis.payload.destination.items[0].key, 'bank_deposits');
  assert.equal(firstAnalysis.payload.source.total, 100); assert.equal(firstAnalysis.payload.balanced, true);
  assert.equal((await request(`/api/reports/balance_sheet/analysis?company=gz&period=${period}`, 'viewer')).response.status, 403);

  const second = await uploadAndPublish(250, '第二版');
  const refreshed = await request(`/api/reports/balance_sheet/analysis?company=gz&period=${period}`);
  assert.equal(refreshed.payload.meta.uploadKey, second.uploadKey); assert.equal(refreshed.payload.meta.version, second.version);
  assert.notEqual(refreshed.payload.meta.uploadKey, firstAnalysis.payload.meta.uploadKey); assert.equal(refreshed.payload.source.total, 250);

  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const feature = fs.readFileSync(path.join(projectDir, 'public', 'asset-liability-analysis.js'), 'utf8');
  const featureStyle = fs.readFileSync(path.join(projectDir, 'public', 'asset-liability-analysis.css'), 'utf8');
  assert.match(frontend, /assetLiabilityAnalysisButtonHtml/); assert.match(frontend, /bindAssetLiabilityAnalysis/);
  assert.match(feature, /\/api\/reports\/balance_sheet\/analysis/); assert.match(feature, /setInterval\(\(\) => load\(\{ quiet: true \}\), 60000\)/);
  assert.match(feature, /setAttribute\('role', 'dialog'\)/); assert.match(feature, /assetLiabilityChartSegments/); assert.match(feature, /assetLiabilityChartLabels/);
  assert.match(feature, /data-analysis-switch/); assert.doesNotMatch(feature, /源表项目与金额/); assert.match(featureStyle, /asset-liability-direct-label/);
});

test('现金流分析读取动态收支项目并随当前发布版本即时切换', async () => {
  const period = '2027-06';
  const cashRaw = (salesAmount, extraLabel = '其他收入') => ({ cash_flow: {
    sourceSheet: '现金流量表-钱去向', maxRow: 15, maxCol: 12, rows: [
      { row: 1, cells: ['现金流量表'] },
      { row: 3, cells: ['项目', '2027年累计', '前期累计金额', '本期金额'] },
      { row: 4, cells: ['一、经营活动产生的现金流量'] },
      { row: 5, cells: ['销售商品、提供劳务收到的现金', salesAmount, 0, salesAmount] },
      { row: 7, cells: [null, null, null, null, null, null, '累计现金收支明细'] },
      { row: 8, cells: [null, null, null, null, null, null, '增减项', '项目', null, '金额', '占比'] },
      { row: 9, cells: [null, null, null, null, null, null, '期初', '期初现金', null, 100] },
      { row: 10, cells: [null, null, null, null, null, null, '加', '销售收入', null, salesAmount] },
      { row: 11, cells: [null, null, null, null, null, null, '加', extraLabel, null, 50] },
      { row: 12, cells: [null, null, null, null, null, null, '合计', '', null, salesAmount + 150] },
      { row: 13, cells: [null, null, null, null, null, null, '减', '经营成本', null, 40] },
      { row: 14, cells: [null, null, null, null, null, null, '减', '新增月度项目', null, 10] },
      { row: 15, cells: [null, null, null, null, null, null, '合计', '', null, 50] }
    ]
  } });
  const uploadAndPublish = async (amount, versionName, extraLabel) => {
    const uploaded = await post('/api/uploads', { companyKey: 'gz', period, reportType: 'cash_flow', fileName: `广州桉侨-${period}-现金流量表-${versionName}.json`, fileType: 'application/json', contentBase64: Buffer.from(JSON.stringify(cashRaw(amount, extraLabel))).toString('base64') });
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
    const published = await post(`/api/uploads/${uploaded.payload.uploadKey}/publish`, {});
    assert.equal(published.response.status, 200, JSON.stringify(published.payload));
    return { uploadKey: uploaded.payload.uploadKey, version: published.payload.version };
  };

  const first = await uploadAndPublish(1000, '第一版', '其他收入');
  const firstAnalysis = await request(`/api/reports/cash_flow/analysis?company=gz&period=${period}`);
  assert.equal(firstAnalysis.response.status, 200); assert.equal(firstAnalysis.response.headers.get('cache-control'), 'no-store');
  assert.equal(firstAnalysis.payload.meta.uploadKey, first.uploadKey); assert.equal(firstAnalysis.payload.meta.version, first.version);
  assert.deepEqual(firstAnalysis.payload.source.items.map(item => item.label), ['期初现金', '销售收入', '其他收入']);
  assert.deepEqual(firstAnalysis.payload.destination.items.map(item => item.label), ['经营成本', '新增月度项目']);
  assert.equal(firstAnalysis.payload.source.total, 1150); assert.equal(firstAnalysis.payload.destination.total, 50);
  assert.equal((await request(`/api/reports/cash_flow/analysis?company=gz&period=${period}`, 'viewer')).response.status, 403);

  const second = await uploadAndPublish(1600, '第二版', '新增融资流入');
  const refreshed = await request(`/api/reports/cash_flow/analysis?company=gz&period=${period}`);
  assert.equal(refreshed.payload.meta.uploadKey, second.uploadKey); assert.equal(refreshed.payload.meta.version, second.version);
  assert.notEqual(refreshed.payload.meta.uploadKey, firstAnalysis.payload.meta.uploadKey);
  assert.equal(refreshed.payload.source.total, 1750); assert.equal(refreshed.payload.source.items.at(-1).label, '新增融资流入');

  const frontend = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
  const feature = fs.readFileSync(path.join(projectDir, 'public', 'cash-flow-analysis.js'), 'utf8');
  assert.match(frontend, /cashFlowAnalysisButtonHtml/); assert.match(frontend, /bindCashFlowAnalysis/);
  assert.match(feature, /\/api\/reports\/cash_flow\/analysis/); assert.match(feature, /累计现金收支明细/);
  assert.match(feature, /data-analysis-switch/); assert.match(feature, /assetLiabilityChartLabels/);
});
