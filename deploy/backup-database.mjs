import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const databaseFile = path.resolve(process.env.DB_FILE || '/var/lib/wecom-finance/report-board.db');
if (process.env.NODE_ENV === 'production' && !databaseFile.startsWith('/var/lib/wecom-finance/')) {
  throw new Error('生产数据库必须位于 /var/lib/wecom-finance/');
}

const backupDirectory = path.join(path.dirname(databaseFile), 'backups');
fs.mkdirSync(backupDirectory, { recursive: true });
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const destination = path.join(backupDirectory, `report-board-${timestamp}.db`);
const database = new Database(databaseFile, { fileMustExist: true });
try {
  await database.backup(destination);
  fs.chmodSync(destination, 0o600);
  console.log(destination);
} finally {
  database.close();
}
