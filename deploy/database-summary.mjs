import path from 'node:path';
import Database from 'better-sqlite3';

const databaseFile = path.resolve(process.env.DB_FILE || '/var/lib/wecom-finance/report-board.db');
if (process.env.NODE_ENV === 'production' && !databaseFile.startsWith('/var/lib/wecom-finance/')) {
  throw new Error('生产数据库必须位于 /var/lib/wecom-finance/');
}

const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
try {
  const integrity = database.pragma('quick_check', { simple: true });
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const summary = tables.map(({ name }) => ({ table: name, rows: database.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count }));
  console.log(JSON.stringify({ databaseFile, integrity, tables: summary }, null, 2));
} finally {
  database.close();
}
