const USER_ID_PATTERN = /^[A-Za-z0-9._@-]{1,100}$/;

export const FINANCE_PLATFORM_ROLES = Object.freeze(['admin', 'general_manager', 'finance']);

const ROLE_LABELS = Object.freeze({
  admin: '管理员',
  general_manager: '总经理',
  finance: '财务组',
});

export function parseBearerToken(value) {
  const match = /^Bearer\s+([^\s]{1,8192})$/i.exec(String(value || '').trim());
  return match?.[1] || '';
}

export function unwrapPlatformData(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

export function normalizePlatformRoles(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(role => String(role || '').trim()).filter(Boolean))].sort();
}

export function hasFinancePlatformAccess(roles) {
  const roleSet = new Set(normalizePlatformRoles(roles));
  return FINANCE_PLATFORM_ROLES.some(role => roleSet.has(role));
}

export function normalizePlatformIdentity(profile, roles) {
  if (!profile || typeof profile !== 'object') throw new Error('小Q未返回有效用户资料');
  const normalizedRoles = normalizePlatformRoles(roles);
  if (!hasFinancePlatformAccess(normalizedRoles)) return null;
  const employeeKey = String(profile.wecomUserId || profile.username || '').trim();
  if (!USER_ID_PATTERN.test(employeeKey)) throw new Error('小Q返回的企微用户 ID 无效');
  const displayName = String(profile.nickname || profile.displayName || profile.username || employeeKey).trim().slice(0, 80) || employeeKey;
  const financeRoles = FINANCE_PLATFORM_ROLES.filter(role => normalizedRoles.includes(role));
  return {
    employeeKey,
    displayName,
    roles: financeRoles,
    department: `小Q成员组：${financeRoles.map(role => ROLE_LABELS[role]).join('、')}`,
  };
}

export function platformDirectoryMembers(groups) {
  if (!Array.isArray(groups)) return [];
  const employees = new Map();
  for (const group of groups) {
    const groupCode = String(group?.group_code || '').trim();
    if (!FINANCE_PLATFORM_ROLES.includes(groupCode)) continue;
    const groupName = String(group?.group_name || ROLE_LABELS[groupCode] || groupCode).trim();
    for (const member of Array.isArray(group?.members) ? group.members : []) {
      const employeeKey = String(member?.wecom_user_id || '').trim();
      if (!USER_ID_PATTERN.test(employeeKey)) continue;
      const existing = employees.get(employeeKey) || { employeeKey, displayName: employeeKey, groups: [] };
      existing.displayName = String(member?.display_name || member?.user_name || existing.displayName).trim().slice(0, 80) || employeeKey;
      if (!existing.groups.includes(groupName)) existing.groups.push(groupName);
      employees.set(employeeKey, existing);
    }
  }
  return [...employees.values()]
    .map(employee => ({ ...employee, department: `小Q成员组：${employee.groups.join('、')}` }))
    .sort((left, right) => left.employeeKey.localeCompare(right.employeeKey));
}

export function platformReturnPath(appBasePath) {
  const normalized = `/${String(appBasePath || '').replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
  if (normalized === '/platform') return '/';
  if (normalized.startsWith('/platform/')) return `${normalized.slice('/platform'.length)}/`.replace(/\/+/g, '/');
  return `${normalized || '/'}/`.replace(/\/+/g, '/');
}
