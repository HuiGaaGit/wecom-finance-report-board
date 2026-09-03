import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const expectedRoot = '/data/data/wecom-finance-report-board';
const dataRoot = path.resolve(process.env.FINANCE_DATA_ROOT || expectedRoot);
const containerName = process.env.FINANCE_CONTAINER_NAME || 'wecom-finance-report-board';
const networkName = process.env.FINANCE_NETWORK_NAME || 'wecom-finance-report-board';
const expectedUid = 20117;
const expectedGid = 20117;
const errors = [];
const dockerJson = args => JSON.parse(execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const isWithin = (candidate, root) => { const relative = path.relative(root, candidate); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };

if (dataRoot !== expectedRoot) errors.push(`FINANCE_DATA_ROOT 必须精确为 ${expectedRoot}`);
if (!fs.existsSync(dataRoot)) errors.push(`财务数据目录不存在：${dataRoot}`);

const inspectPrivateTree = root => {
  const queue = [root];
  while (queue.length) {
    const current = queue.pop(); const stat = fs.lstatSync(current); const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) { errors.push(`财务数据目录禁止符号链接：${current}`); continue; }
    if (stat.uid !== expectedUid || stat.gid !== expectedGid) errors.push(`owner 不符合 ${expectedUid}:${expectedGid}：${current}`);
    if (stat.isDirectory()) {
      if (mode !== 0o700) errors.push(`目录权限不是 0700：${current}`);
      for (const name of fs.readdirSync(current)) queue.push(path.join(current, name));
    } else if (stat.isFile() && mode !== 0o600) errors.push(`文件权限不是 0600：${current}`);
  }
};
if (fs.existsSync(dataRoot)) inspectPrivateTree(dataRoot);

let containers = [];
try {
  const ids = execFileSync('docker', ['ps', '-aq'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  containers = ids.length ? dockerJson(['inspect', ...ids]) : [];
} catch (error) { errors.push(`无法读取 Docker 容器状态：${error.message}`); }

const finance = containers.find(item => item?.Name === `/${containerName}`);
if (!finance) errors.push(`财务容器未运行或不存在：${containerName}`);
if (finance && finance.Config?.User !== `${expectedUid}:${expectedGid}`) errors.push(`财务容器用户不是 ${expectedUid}:${expectedGid}`);
if (finance && finance.HostConfig?.ReadonlyRootfs !== true) errors.push('财务容器根文件系统不是只读');
if (finance && !(finance.HostConfig?.CapDrop || []).includes('ALL')) errors.push('财务容器未移除全部 Linux capabilities');
if (finance && !(finance.HostConfig?.SecurityOpt || []).some(item => String(item).includes('no-new-privileges'))) errors.push('财务容器未启用 no-new-privileges');
if (finance) {
  const attachedNetworks = Object.keys(finance.NetworkSettings?.Networks || {});
  if (attachedNetworks.length !== 1 || attachedNetworks[0] !== networkName) errors.push(`财务容器连接了非专用网络：${attachedNetworks.join(', ') || '无网络'}`);
}

for (const container of containers) {
  const name = String(container?.Name || '').replace(/^\//, '') || 'unknown';
  for (const mount of container?.Mounts || []) {
    const source = path.resolve(String(mount.Source || '/unresolved'));
    const destination = String(mount.Destination || '');
    if (/docker\.sock$/i.test(source) || /docker\.sock$/i.test(destination)) errors.push(`容器 ${name} 挂载了 Docker Socket`);
    const touchesFinance = isWithin(source, dataRoot) || isWithin(dataRoot, source);
    if (touchesFinance && name !== containerName) errors.push(`其他容器 ${name} 挂载了财务数据路径：${source}`);
  }
}

if (finance) {
  const bindings = finance.NetworkSettings?.Ports?.['3180/tcp'] || [];
  if (!bindings.length || bindings.some(item => !['127.0.0.1', '::1'].includes(item.HostIp))) errors.push('财务端口 3180 未仅绑定回环地址');
}

try {
  const network = dockerJson(['network', 'inspect', networkName])[0];
  const members = Object.values(network?.Containers || {}).map(item => item.Name).filter(Boolean);
  if (members.length !== 1 || members[0] !== containerName) errors.push(`财务 Docker 网络成员异常：${members.join(', ') || '无成员'}`);
} catch (error) { errors.push(`无法检查财务 Docker 网络：${error.message}`); }

if (errors.length) {
  console.error('财务运行时隔离检查失败：');
  for (const error of errors.slice(0, 100)) console.error(`- ${error}`);
  if (errors.length > 100) console.error(`- 另有 ${errors.length - 100} 项未展开`);
  process.exit(1);
}
console.log(`财务运行时隔离检查通过：${containerName} · ${expectedUid}:${expectedGid} · ${dataRoot}`);
