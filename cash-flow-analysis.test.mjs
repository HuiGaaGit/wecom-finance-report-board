import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCashFlowAnalysis } from './cash-flow-analysis.mjs';

const row = (number, values) => ({ row: number, cells: values });

test('现金流分析按标题和字段表头映射来源与去向，不依赖固定单元格', () => {
  const result = parseCashFlowAnalysis({ sourceSheet: '现金流量表-钱去向', rows: [
    row(1, ['现金流量表']),
    row(5, [null, null, null, null, null, null, '累计现金收支明细']),
    row(6, [null, null, null, null, null, null, '增减项', '项目', null, '金额', '占比']),
    row(7, [null, null, null, null, null, null, '期初', '期初现金', null, '-', 0]),
    row(8, [null, null, null, null, null, null, '加', '销售收入', null, '1,196,783', 0.794]),
    row(9, [null, null, null, null, null, null, '加', '其他收入', null, 10382, 0.007]),
    row(10, [null, null, null, null, null, null, '加', '收到的税费返还', null, 0, 0]),
    row(11, [null, null, null, null, null, null, '加', '吸收投资收到的现金', null, 300000, 0.199]),
    row(12, [null, null, null, null, null, null, '合计', '', null, 1507165, 1]),
    row(13, [null, null, null, null, null, null, '减', '经营成本', null, 111520, 0.074]),
    row(14, [null, null, null, null, null, null, '减', '佣金支出', null, 2729, 0.002]),
    row(15, [null, null, null, null, null, null, '减', '员工工资及福利', null, 160325, 0.106]),
    row(16, [null, null, null, null, null, null, '减', '日常运营费用', null, 140739, 0.093]),
    row(17, [null, null, null, null, null, null, '减', 'James借款', null, 70000, 0.046]),
    row(18, [null, null, null, null, null, null, '减', '租赁保证金', null, 32000, 0.021]),
    row(19, [null, null, null, null, null, null, '合计', '', null, 517313, 1])
  ] });

  assert.equal(result.available, true);
  assert.equal(result.complete, true);
  assert.equal(result.mappingVersion, 1);
  assert.equal(result.analysisTitle, '累计现金收支明细');
  assert.equal(result.source.items.length, 5);
  assert.equal(result.destination.items.length, 6);
  assert.equal(result.source.items[0].key, 'opening_cash');
  assert.equal(result.source.items[1].key, 'sales_receipts');
  assert.equal(result.source.items.at(-1).key, 'investment_receipts');
  assert.equal(result.destination.items[0].key, 'operating_cost');
  assert.equal(result.destination.items[2].key, 'payroll');
  assert.equal(result.destination.items[4].key, 'loan_repayment');
  assert.equal(result.destination.items.at(-1).key, 'deposit_payment');
  assert.equal(result.source.items[0].amountAvailable, false);
  assert.equal(result.source.total, 1507165);
  assert.equal(result.destination.total, 517313);
  assert.equal(result.netAmount, 989852);
  assert.deepEqual(result.warnings, []);
});

test('不同月份新增项目保持原文和顺序，负数与括号金额按资金规模映射', () => {
  const result = parseCashFlowAnalysis({ rows: [
    row(20, ['2027年累计现金收支明细']),
    row(22, ['增减方向', '项目名称', '金额']),
    row(23, ['加', '本月新增来源', '￥1,234.50元']),
    row(24, ['', '销售商品、提供劳务收到的现金', 765.5]),
    row(25, ['合计', '', 2000]),
    row(26, ['减', '新增市场活动支出', '(350.25)']),
    row(27, ['', '购建固定资产支付的现金', -149.75]),
    row(28, ['总计', '', 500])
  ] });
  assert.deepEqual(result.source.items.map(item => item.label), ['本月新增来源', '销售商品、提供劳务收到的现金']);
  assert.deepEqual(result.source.items.map(item => item.amount), [1234.5, 765.5]);
  assert.equal(result.source.items[0].key, 'other');
  assert.equal(result.source.items[1].key, 'sales_receipts');
  assert.deepEqual(result.destination.items.map(item => item.amount), [350.25, 149.75]);
  assert.equal(result.destination.items[0].key, 'other');
  assert.equal(result.destination.items[1].key, 'fixed_asset_purchase');
  assert.equal(result.destination.total, 500);
});

test('现金流分析缺失锚点或合计时给出明确状态且不虚构其他月份数据', () => {
  const missing = parseCashFlowAnalysis({ sourceSheet: '现金流量表', rows: [row(1, ['项目', '本期金额'])] });
  assert.equal(missing.available, false);
  assert.equal(missing.complete, false);
  assert.match(missing.warnings.join('；'), /未识别到/);

  const partial = parseCashFlowAnalysis({ rows: [
    row(1, ['累计现金收支明细']), row(2, ['增减项', '项目', '金额']),
    row(3, ['加', '销售收入', 100]), row(4, ['减', '经营成本', 40])
  ] });
  assert.equal(partial.available, true);
  assert.equal(partial.complete, false);
  assert.equal(partial.source.total, 100);
  assert.equal(partial.destination.total, 40);
  assert.match(partial.warnings.join('；'), /缺少合计行/);
});

test('现金流分析前端复用资产负债弹窗结构、交互图表和清晰焦点样式', () => {
  const feature = fs.readFileSync(new URL('./public/cash-flow-analysis.js', import.meta.url), 'utf8');
  const sharedStyle = fs.readFileSync(new URL('./public/asset-liability-analysis.css', import.meta.url), 'utf8');
  const dockerfile = fs.readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8');
  const releaseScript = fs.readFileSync(new URL('./deploy/build-release.ps1', import.meta.url), 'utf8');
  assert.match(feature, /assetLiabilityChartSegments/);
  assert.match(feature, /\/api\/reports\/cash_flow\/analysis/);
  assert.match(feature, /data-analysis-switch/);
  assert.match(feature, /setInterval\(\(\) => load\(\{ quiet: true \}\), 60000\)/);
  assert.match(feature, /visibilitychange/);
  assert.match(sharedStyle, /\[data-analysis-segment\]:focus-visible\{outline:none!important\}/);
  assert.match(sharedStyle, /asset-liability-close:focus-visible\{outline:2px solid rgba\(44,128,201,\.55\)/);
  assert.match(sharedStyle, /asset-liability-label-name\{font-size:13\.5px\}/);
  assert.match(dockerfile, /cash-flow-analysis\.mjs/);
  assert.match(releaseScript, /cash-flow-analysis\.mjs/);
});
