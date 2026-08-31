import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasFinancePlatformAccess,
  normalizePlatformIdentity,
  parseBearerToken,
  platformDirectoryMembers,
  platformReturnPath,
  unwrapPlatformData,
} from './platform-auth.mjs';

test('只接受格式正确的 Bearer 登录令牌', () => {
  assert.equal(parseBearerToken('Bearer token-value'), 'token-value');
  assert.equal(parseBearerToken('bearer token-value'), 'token-value');
  assert.equal(parseBearerToken('token-value'), '');
  assert.equal(parseBearerToken('Bearer token value'), '');
});

test('财务入口只接受管理员、总经理和财务组', () => {
  assert.equal(hasFinancePlatformAccess(['finance']), true);
  assert.equal(hasFinancePlatformAccess(['general_manager']), true);
  assert.equal(hasFinancePlatformAccess(['admin']), true);
  assert.equal(hasFinancePlatformAccess(['consultant']), false);
  assert.equal(normalizePlatformIdentity({ username: 'Outside' }, ['consultant']), null);
});

test('小Q用户资料规范化为财务员工身份', () => {
  assert.deepEqual(
    normalizePlatformIdentity(
      { username: 'fallback', nickname: 'Hewson（许嘉杰）', wecomUserId: 'XuJiaJie' },
      ['finance', 'admin', 'finance'],
    ),
    {
      employeeKey: 'XuJiaJie',
      displayName: 'Hewson（许嘉杰）',
      roles: ['admin', 'finance'],
      department: '小Q成员组：管理员、财务组',
    },
  );
});

test('管理员同步目录时只取三个授权组并合并重复成员', () => {
  assert.deepEqual(platformDirectoryMembers([
    { group_code: 'admin', group_name: '管理员', members: [{ wecom_user_id: 'XuJiaJie', display_name: 'Hewson（许嘉杰）' }] },
    { group_code: 'finance', group_name: '财务组', members: [{ wecom_user_id: 'XuJiaJie', display_name: 'Hewson（许嘉杰）' }, { wecom_user_id: 'MaYunJie', display_name: 'Jet（马云杰）' }] },
    { group_code: 'consultant', group_name: '顾问', members: [{ wecom_user_id: 'Outside', display_name: '外部成员' }] },
  ]), [
    { employeeKey: 'MaYunJie', displayName: 'Jet（马云杰）', groups: ['财务组'], department: '小Q成员组：财务组' },
    { employeeKey: 'XuJiaJie', displayName: 'Hewson（许嘉杰）', groups: ['管理员', '财务组'], department: '小Q成员组：管理员、财务组' },
  ]);
});

test('平台响应与登录回跳路径保持小Q协议', () => {
  assert.deepEqual(unwrapPlatformData({ code: 20000, data: { roles: ['finance'] } }), { roles: ['finance'] });
  assert.equal(platformReturnPath('/platform/finance'), '/finance/');
});
