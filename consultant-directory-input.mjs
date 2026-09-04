import fs from 'node:fs';
import path from 'node:path';

const normalizedName = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
const canonicalName = value => {
  const text = normalizedName(value).replace(/\s+/g, '');
  return text.match(/[\u4e00-\u9fa5]{2,6}/g)?.at(-1) || text.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
};

const publishedConsultantNames = database => {
  const uploads = database.prepare("SELECT raw_path FROM upload_batches WHERE report_type = 'payroll_statement' AND status = 'published' ORDER BY published_at DESC").all();
  const names = new Map();
  for (const upload of uploads) {
    if (!upload?.raw_path || !fs.existsSync(upload.raw_path)) continue;
    try {
      const payload = JSON.parse(fs.readFileSync(upload.raw_path, 'utf8'));
      const report = payload.payroll_statement || payload.uploaded?.payroll_statement || payload;
      for (const row of report.payrollRows || []) {
        if (!/顾问/.test(String(row.department || '').replace(/\s+/g, ''))) continue;
        const name = normalizedName(row.name); const key = canonicalName(row.canonicalName || name);
        if (name && key) names.set(key, name);
      }
    } catch {}
  }
  if (!names.size) throw new Error('已发布工资表中尚未识别到顾问部门人员');
  if (names.size > 5000) throw new Error('顾问匹配清单超过安全上限');
  return [...names.values()].sort((left, right) => left.localeCompare(right, 'zh-CN'));
};

const writeConsultantDirectoryInput = (database, outputFile) => {
  const people = publishedConsultantNames(database).map(name => ({ name }));
  const payload = { schemaVersion: 1, generatedAt: new Date().toISOString(), people };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error('顾问匹配清单超过安全文件大小');
  fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
  const temporary = `${outputFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, serialized, { mode: 0o600 }); fs.renameSync(temporary, outputFile); fs.chmodSync(outputFile, 0o600);
  return { generatedAt: payload.generatedAt, people: people.length };
};

export { canonicalName, publishedConsultantNames, writeConsultantDirectoryInput };
