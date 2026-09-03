import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAssetLiabilityAnalysis } from './asset-liability-analysis.mjs';
import { assetLiabilityChartSegments } from './public/asset-liability-analysis.js';

const row = (number, values) => ({ row: number, cells: values });

test('资产负债分析按标题和表头锚点映射两侧项目，不依赖固定单元格', () => {
  const raw = {
    sourceSheet: '资产负债表',
    rows: [
      row(1, ['资产负债表']),
      row(4, [null, null, null, null, null, null, '资产负债分析', null, null, null, null]),
      row(5, [null, null, null, null, null, null, '2026年负债、资产-钱的来源', null, null, null, '2026年钱的去向']),
      row(6, [null, null, null, null, null, null, '项目', null, '金额', null, '项目', null, '金额']),
      row(7, [null, null, null, null, null, null, '未付账款-成本', null, 397586, null, '银行存款', null, '989,851']),
      row(8, [null, null, null, null, null, null, '未付账款-佣金', null, 200, null, '未收款', null, 961637]),
      row(9, [null, null, null, null, null, null, '预收款', null, 165000, null, '预付款', null, 72000]),
      row(10, [null, null, null, null, null, null, '未付工资', null, 180990, null, '租赁保证金', null, 32000]),
      row(11, [null, null, null, null, null, null, '投资款', null, 300000, null, '社会保险费（员工个人部分）', null, 3840]),
      row(12, [null, null, null, null, null, null, '未付代付款', null, 755022.27, null, '公积金（员工个人部分）', null, 2880]),
      row(13, [null, null, null, null, null, null, '未付税费-个税', null, 3710.13, null, '固定资产', null, '—']),
      row(14, [null, null, null, null, null, null, '赚的钱', null, 259700, null, '合计', null, 2062208]),
      row(15, [null, null, null, null, null, null, '合计', null, 2062208]),
      row(22, [null, null, null, null, null, null, '钱的来源']),
      row(23, [null, null, null, null, null, null, '旧饼图标题，不应作为数据表'])
    ]
  };

  const result = parseAssetLiabilityAnalysis(raw);
  assert.equal(result.available, true);
  assert.equal(result.complete, true);
  assert.equal(result.balanced, true);
  assert.equal(result.mappingVersion, 1);
  assert.equal(result.source.items.length, 8);
  assert.equal(result.destination.items.length, 7);
  assert.equal(result.source.items[0].key, 'unpaid_cost');
  assert.equal(result.source.items[1].key, 'unpaid_commission');
  assert.equal(result.source.items.at(-1).key, 'earned_profit');
  assert.equal(result.destination.items[0].key, 'bank_deposits');
  assert.equal(result.destination.items[4].key, 'employee_social_insurance');
  assert.equal(result.destination.items.at(-1).key, 'fixed_assets');
  assert.equal(result.destination.items.at(-1).amountAvailable, false);
  assert.equal(result.source.total, 2062208);
  assert.equal(result.destination.total, 2062208);
  assert.equal(result.difference, 0);
  assert.equal(result.source.headerRow, 6);
  assert.equal(result.destination.itemColumn, 11);
  assert.deepEqual(result.warnings, []);
});

test('未知项目保留为 other，金额文本与括号负数可解析', () => {
  const result = parseAssetLiabilityAnalysis({ rows: [
    row(2, ['钱的来源']), row(3, ['项目', '金额']),
    row(4, ['新增来源项目', '￥1,234.50']), row(5, ['调整项目', '(34.50)']), row(6, ['合计', 1200]),
    row(2, [null, null, null, '钱的去处']), row(3, [null, null, null, '项目', '金额']),
    row(4, [null, null, null, '银行存款', 1200]), row(5, [null, null, null, '合计', 1200])
  ] });
  assert.equal(result.source.items[0].key, 'other');
  assert.equal(result.source.items[0].amount, 1234.5);
  assert.equal(result.source.items[1].amount, -34.5);
  assert.equal(result.source.calculatedTotal, 1200);
  assert.equal(result.destination.items[0].key, 'bank_deposits');
  assert.equal(result.balanced, true);
});

test('缺少分析区或合计行时返回明确状态且不伪造勾稽一致', () => {
  const missing = parseAssetLiabilityAnalysis({ sourceSheet: '资产负债表', rows: [row(1, ['资产负债表'])] });
  assert.equal(missing.available, false);
  assert.equal(missing.complete, false);
  assert.equal(missing.balanced, false);
  assert.equal(missing.warnings.length, 2);

  const partial = parseAssetLiabilityAnalysis({ rows: [
    row(1, ['钱的来源']), row(2, ['项目', '金额']), row(3, ['投资款', 100]),
    row(1, [null, null, null, '钱的去向']), row(2, [null, null, null, '项目', '金额']), row(3, [null, null, null, '银行存款', 100])
  ] });
  assert.equal(partial.available, true);
  assert.equal(partial.complete, false);
  assert.equal(partial.balanced, false);
  assert.equal(partial.source.total, 100);
  assert.match(partial.warnings.join('；'), /缺少合计行/);
});

test('图表只绘制正数项目，按金额排序并形成连续占比', () => {
  const segments = assetLiabilityChartSegments([
    { label: '小项', amount: 20 }, { label: '负数调整', amount: -5 }, { label: '大项', amount: 60 }, { label: '零值', amount: 0 }, { label: '中项', amount: 20 }
  ]);
  assert.deepEqual(segments.map(item => item.label), ['大项', '小项', '中项']);
  assert.deepEqual(segments.map(item => Number(item.percent.toFixed(1))), [60, 20, 20]);
  assert.deepEqual(segments.map(item => Number(item.offset.toFixed(1))), [0, 60, 80]);
  assert.equal(Number(segments.reduce((sum, item) => sum + item.percent, 0).toFixed(4)), 100);
});
