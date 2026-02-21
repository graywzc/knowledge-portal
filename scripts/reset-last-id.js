#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { Database } = require('../db/Database');

// Lightweight .env loader (same style as mtproto-sync.js)
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) {
      const k = t.slice(0, i);
      const v = t.slice(i + 1);
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

function usage() {
  console.log(`Usage:
  node scripts/reset-last-id.js [value]

Examples:
  node scripts/reset-last-id.js 0
  node scripts/reset-last-id.js 560

Defaults:
  value: 0
  key: mtproto_last_id:<TG_CHAT_ID|TELEGRAM_CHAT_ID>:all

Env overrides:
  RESET_KEY=mtproto_last_id:-100123:all
  DB_PATH=data/dev.db
`);
}

(function main() {
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    usage();
    process.exit(0);
  }

  const value = Number(arg ?? 0);
  if (!Number.isFinite(value) || value < 0) {
    console.error('Invalid value. Must be a non-negative number.');
    process.exit(1);
  }

  const dbPath = process.env.DB_PATH || 'data/dev.db';
  const chatId = process.env.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  const key = process.env.RESET_KEY || `mtproto_last_id:${chatId}:all`;

  if (!chatId && !process.env.RESET_KEY) {
    console.error('Missing TG_CHAT_ID/TELEGRAM_CHAT_ID. Set one or pass RESET_KEY.');
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.db.exec(`CREATE TABLE IF NOT EXISTS poller_state (key TEXT PRIMARY KEY, value TEXT)`);

  const prev = db.db.prepare('SELECT value FROM poller_state WHERE key=?').get(key);
  db.db.prepare('INSERT OR REPLACE INTO poller_state (key, value) VALUES (?, ?)').run(key, String(Math.floor(value)));
  const next = db.db.prepare('SELECT value FROM poller_state WHERE key=?').get(key);

  console.log(`[reset-last-id] DB: ${dbPath}`);
  console.log(`[reset-last-id] key: ${key}`);
  console.log(`[reset-last-id] previous: ${prev ? prev.value : '(none)'}`);
  console.log(`[reset-last-id] current:  ${next ? next.value : '(none)'}`);

  db.close();
})();
