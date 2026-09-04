#!/usr/bin/env node
import Database from 'better-sqlite3';
import path from 'node:path';
import { writeConsultantDirectoryInput } from '../consultant-directory-input.mjs';

process.umask(0o077);
const dbFile = process.env.DB_FILE || '/var/lib/wecom-finance/report-board.db';
const outputFile = process.env.CONSULTANT_DIRECTORY_INPUT_FILE || path.join(path.dirname(dbFile), 'consultant-directory-input.json');
const database = new Database(dbFile, { readonly: true, fileMustExist: true });
try {
  writeConsultantDirectoryInput(database, outputFile);
  process.stdout.write('顾问匹配清单已在财务数据卷内更新。\n');
} finally { database.close(); }
