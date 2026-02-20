#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { TelegramUserIngestor } = require('../ingestion/TelegramUserIngestor');

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

(async () => {
  const ingestor = new TelegramUserIngestor({
    apiId: process.env.TG_API_ID,
    apiHash: process.env.TG_API_HASH,
    phone: process.env.TG_PHONE,
    dbPath: process.env.DB_PATH || 'data/dev.db',
    chatId: process.env.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID,
    topicId: process.env.TG_TOPIC_ID || null,
    sessionPath: process.env.TG_SESSION_PATH || 'data/telegram_user.session',
  });

  await ingestor.start();

  const mode = process.argv[2] || 'once';
  if (mode === 'loop') {
    await ingestor.runLoop({ intervalMs: Number(process.env.TG_SYNC_INTERVAL_MS || 5000) });
  } else {
    await ingestor.syncOnce({ backfillLimit: Number(process.env.TG_BACKFILL_LIMIT || 500) });
    // one-shot mode should terminate cleanly
    await ingestor.client.disconnect();
    process.exit(0);
  }
})();
