import fs from 'node:fs';

const envFile = process.argv[2] || '/etc/wecom-finance/report-board.env';
const targetName = String(process.env.CHECK_NAME || '').trim();
const values = {};
for (const rawLine of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const index = line.indexOf('=');
  if (index < 1) continue;
  values[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
}

const corpId = values.WECOM_CORP_ID || '';
const secret = values.WECOM_SECRET || '';
if (!corpId || !secret) throw new Error('服务器环境文件缺少企微应用凭证');

const api = async (pathname, parameters) => {
  const url = `https://qyapi.weixin.qq.com${pathname}?${new URLSearchParams(parameters)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.errcode || 0) !== 0) throw new Error(payload.errmsg || `HTTP ${response.status}`);
  return payload;
};

try {
  const tokenPayload = await api('/cgi-bin/gettoken', { corpid: corpId, corpsecret: secret });
  const token = tokenPayload.access_token;
  const agent = await api('/cgi-bin/agent/get', { access_token: token, agentid: values.WECOM_AGENT_ID });
  const directUsers = agent.allow_userinfos?.user || [];
  const departmentIds = new Set((agent.allow_partys?.partyid || []).map(String));
  const tagIds = agent.allow_tags?.tagid || [];
  const visibleEmployees = new Map();
  for (const item of directUsers) {
    const profile = await api('/cgi-bin/user/get', { access_token: token, userid: item.userid });
    if (profile.userid && profile.name) visibleEmployees.set(String(profile.userid), profile.name);
  }
  for (const tagId of tagIds) {
    const tag = await api('/cgi-bin/tag/get', { access_token: token, tagid: tagId });
    for (const item of tag.userlist || []) if (item.userid && item.name) visibleEmployees.set(String(item.userid), item.name);
    for (const departmentId of tag.partylist || []) departmentIds.add(String(departmentId));
  }
  if (!departmentIds.size && !directUsers.length && !tagIds.length) departmentIds.add('1');
  for (const departmentId of departmentIds) {
    const employees = await api('/cgi-bin/user/simplelist', { access_token: token, department_id: departmentId, fetch_child: 1 });
    for (const item of employees.userlist || []) if (item.userid && item.name) visibleEmployees.set(String(item.userid), item.name);
  }
  console.log(JSON.stringify({
    ok: true,
    visibleScope: { directUsers: directUsers.length, departments: departmentIds.size, tags: tagIds.length },
    employeeCount: visibleEmployees.size,
    targetMatched: targetName ? [...visibleEmployees.values()].some(name => name === targetName) : null
  }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }));
  process.exitCode = 1;
}
