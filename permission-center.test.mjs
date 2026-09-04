import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { permissionCenterTestHelpers } from './public/permission-center.js';

test('权限中心使用四个顶层视图、两栏编辑和按需生效摘要', () => {
  const source = fs.readFileSync(new URL('./public/permission-center.js', import.meta.url), 'utf8');
  const styles = fs.readFileSync(new URL('./public/styles.css', import.meta.url), 'utf8');
  assert.match(source, /\['employees', '员工授权'\].*\['roles', '角色预设'\].*\['audit', '授权审计'\].*\['global', '全局设置'\]/s);
  assert.match(source, /\['quick', '快速配置'\].*\['matrix', '模块权限'\].*\['advanced', '高级设置'\]/s);
  assert.match(source, /permission-summary-drawer/);
  assert.doesNotMatch(source, /<aside id="permission-summary"/);
  assert.match(styles, /\.permission-workbench\{display:grid;grid-template-columns:248px minmax\(0,1fr\)/);
  assert.match(styles, /permission-workbench:not\(\.mobile-detail\) \.permission-editor\{display:none\}/);
  assert.match(styles, /permission-workbench\.mobile-detail \.permission-people-panel\{display:none\}/);
});

test('权限矩阵按分类映射动作且各分析页父子依赖保持不变', () => {
  const { actionFor, applyDependencies, matrixRows, riskPermission } = permissionCenterTestHelpers;
  assert.equal(actionFor('reports', 'report.income_statement.summary.view'), 'view');
  assert.equal(actionFor('reports', 'report.income_statement.detail.export'), 'detail_export');
  assert.equal(actionFor('analysis', 'module.cash_analysis.net_positions.view'), 'sensitive');
  assert.equal(actionFor('analysis', 'module.intercompany_reconciliation.detail'), 'sensitive');
  assert.equal(actionFor('analysis', 'module.financial_brief.notes.manage'), 'sensitive');
  assert.equal(actionFor('uploads', 'module.uploads.publish'), 'publish');
  assert.equal(actionFor('system', 'module.database.manage'), 'manage');
  assert.equal(riskPermission('module.database.manage'), true);
  const childOnly = applyDependencies(new Set(['module.cash_analysis.net_positions.view']));
  assert.equal(childOnly.has('module.cash_analysis.view'), true);
  const parentRemoved = applyDependencies(new Set(['module.cash_analysis.net_positions.view']), 'module.cash_analysis.view', false);
  assert.equal(parentRemoved.has('module.cash_analysis.net_positions.view'), false);
  const businessChild = applyDependencies(new Set(['module.main_business_analysis.gross_trend.view']));
  assert.equal(businessChild.has('module.main_business_analysis.view'), true);
  const briefNoteChild = applyDependencies(new Set(['module.financial_brief.notes.manage']));
  assert.equal(briefNoteChild.has('module.financial_brief.view'), true);
  const briefParentRemoved = applyDependencies(new Set(['module.financial_brief.view', 'module.financial_brief.notes.manage']), 'module.financial_brief.view', false);
  assert.equal(briefParentRemoved.has('module.financial_brief.notes.manage'), false);
  const systemRows = matrixRows({ id: 'system', children: [{ key: 'module.permissions.manage', name: '权限管理' }, { key: 'module.database.view', name: '数据库浏览' }, { key: 'module.database.manage', name: '数据库管理' }] });
  assert.deepEqual(systemRows.map(row => row.id), ['permissions', 'database']);
  assert.equal(systemRows[1].leaves.length, 2);
});

test('权限草稿签名只随既有保存字段变化', () => {
  const { profileSignature } = permissionCenterTestHelpers;
  const profile = { presetRoleKey: 'viewer', permissionKeys: ['b', 'a'], companyKeys: ['gz'], fromPeriod: '2026-01', toPeriod: '2026-12', accountVisibility: 'level1', showDirection: true, showFullEntry: false, name: '员工甲' };
  assert.equal(profileSignature(profile), profileSignature({ ...profile, permissionKeys: ['a', 'b'], name: '员工乙' }));
  assert.notEqual(profileSignature(profile), profileSignature({ ...profile, companyKeys: ['sz'] }));
});

test('数据范围支持全部不可见并与全部公司、单家公司互斥', () => {
  const { companyScopeForSelection } = permissionCenterTestHelpers;
  assert.deepEqual(companyScopeForSelection(['__none__'], '__none__', true), []);
  assert.deepEqual(companyScopeForSelection(['__none__', 'gz'], 'gz', true), ['gz']);
  assert.deepEqual(companyScopeForSelection(['gz', '*'], '*', true), ['*']);
  assert.deepEqual(companyScopeForSelection([], 'gz', false), []);
  const source = fs.readFileSync(new URL('./public/permission-center.js', import.meta.url), 'utf8');
  assert.match(source, /value="\$\{hiddenCompanyScopeValue\}"[\s\S]*全部不可见/);
  assert.match(source, /未配置员工默认全部不可见/);
});

test('未选择全部公司或桉侨集团时隐藏并清除集团专属模块权限', () => {
  const { permissionKeysForCompanyScope, scopedMatrixRows } = permissionCenterTestHelpers;
  const catalog = [{ id: 'reports', children: [
    { id: 'income_statement', name: '利润表', children: [{ key: 'report.income_statement.summary.view', name: '浏览报表' }] },
    { id: 'consolidated_income_statement', name: '桉侨集团合并利润表', requiredCompanyKey: 'group', children: [{ key: 'report.consolidated_income_statement.summary.view', name: '浏览报表' }] }
  ] }];
  const groupKey = 'report.consolidated_income_statement.summary.view';
  const companyKey = 'report.income_statement.summary.view';

  assert.deepEqual(scopedMatrixRows(catalog[0], ['gz']).map(row => row.id), ['income_statement']);
  assert.deepEqual(scopedMatrixRows(catalog[0], ['group']).map(row => row.id), ['income_statement', 'consolidated_income_statement']);
  assert.deepEqual(scopedMatrixRows(catalog[0], ['*']).map(row => row.id), ['income_statement', 'consolidated_income_statement']);
  assert.deepEqual(permissionKeysForCompanyScope([companyKey, groupKey], ['gz'], catalog), [companyKey]);
  assert.deepEqual(permissionKeysForCompanyScope([companyKey, groupKey], [], catalog), [companyKey]);
  assert.deepEqual(permissionKeysForCompanyScope([companyKey, groupKey], ['group'], catalog), [groupKey, companyKey].sort());
});
