#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const input = require('input');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

(async () => {
  const apiId = Number(process.env.TG_API_ID || process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TG_API_HASH || process.env.TELEGRAM_API_HASH;
  const phone = process.env.TG_PHONE || process.env.TELEGRAM_PHONE || '';
  const sessionPath = process.env.TG_SESSION_PATH
    ? path.resolve(process.cwd(), process.env.TG_SESSION_PATH)
    : path.join(process.cwd(), 'data/telegram_user.session');

  if (!apiId || !apiHash) {
    console.error('Missing TG_API_ID/TG_API_HASH (or TELEGRAM_API_ID/TELEGRAM_API_HASH).');
    process.exit(1);
  }

  const existingSession = fs.existsSync(sessionPath)
    ? fs.readFileSync(sessionPath, 'utf8').trim()
    : '';

  const client = new TelegramClient(new StringSession(existingSession), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => phone || await input.text('Phone number (+1...): '),
    password: async () => await input.text('2FA password (if enabled): '),
    phoneCode: async () => await input.text('Telegram login code: '),
    onError: (err) => console.error('[MTProto login error]', err.message),
  });

  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, client.session.save(), 'utf8');

  console.log(`MTProto session initialized and saved to: ${sessionPath}`);
  await client.disconnect();
})().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
