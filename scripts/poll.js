#!/usr/bin/env node
/**
 * Start the Telegram polling ingestion process.
 * Run: npm run poll
 *
 * Reads config from .env or environment variables:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_SELF_USER_ID, DB_PATH
 */

// Load .env
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq);
      const val = trimmed.slice(eq + 1);
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const { TelegramPoller } = require('../ingestion/TelegramPoller');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const poller = new TelegramPoller({
  token,
  dbPath: process.env.DB_PATH || path.join(__dirname, '../data/portal.db'),
  chatId: process.env.TELEGRAM_CHAT_ID || null,
  selfUserId: process.env.TELEGRAM_SELF_USER_ID || null,
});

// Graceful shutdown
process.on('SIGINT', () => { poller.stop(); });
process.on('SIGTERM', () => { poller.stop(); });

poller.start();
