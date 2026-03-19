#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { TelegramSender } = require('../services/TelegramSender');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

function usage() {
  console.log(`Usage:\n  node scripts/test-send-text.js <chatId> <text> [replyToId]\n\nExample:\n  node scripts/test-send-text.js -1003826585913 "hello from CLI"\n  node scripts/test-send-text.js -1003826585913 "reply test" 1623\n`);
}

(async () => {
  loadEnv(path.join(process.cwd(), '.env'));

  const [, , chatId, text, replyToId] = process.argv;
  if (!chatId || !text) {
    usage();
    process.exit(1);
  }

  const sender = new TelegramSender();
  try {
    const result = await sender.sendText({
      chatId,
      text,
      replyToId,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sender.close();
  }
})().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
