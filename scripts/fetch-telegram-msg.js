#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

(async () => {
  const [, , chatIdArg, msgIdArg] = process.argv;
  const chatId = chatIdArg || process.env.TG_CHAT_ID || "-1003826585913";
  const msgId = Number(msgIdArg || "1623");

  loadEnv(path.join(process.cwd(), ".env"));

  const apiId = Number(process.env.TELEGRAM_API_ID || process.env.TG_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH || process.env.TG_API_HASH;
  const sessPath = process.env.TG_SESSION_PATH
    ? path.resolve(process.cwd(), process.env.TG_SESSION_PATH)
    : path.join(process.cwd(), "data", "telegram_user.session");
  const sessionStr = fs.existsSync(sessPath) ? fs.readFileSync(sessPath, "utf8").trim() : "";

  if (!apiId || !apiHash || !sessionStr) {
    console.error(JSON.stringify({
      error: "missing TELEGRAM_API_ID|TG_API_ID / TELEGRAM_API_HASH|TG_API_HASH / session file (TG_SESSION_PATH or data/telegram_user.session)"
    }, null, 2));
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 5
  });

  await client.connect();
  const entity = await client.getEntity(chatId);
  const res = await client.getMessages(entity, { ids: [msgId] });
  const m = Array.isArray(res) ? res[0] : res;

  if (!m) {
    console.log(JSON.stringify({ error: "message_not_found", chatId, msgId }, null, 2));
    await client.disconnect();
    return;
  }

  const out = {
    id: m.id,
    date: m.date,
    message: m.message,
    chatId: String(m.chatId || ""),
    senderId: String(m.senderId || ""),
    replyTo: m.replyTo
      ? {
          className: m.replyTo.className,
          replyToMsgId: m.replyTo.replyToMsgId,
          replyToTopId: m.replyTo.replyToTopId,
          forumTopic: m.replyTo.forumTopic
        }
      : null,
    entities: (m.entities || []).map((e) => ({
      className: e.className,
      offset: e.offset,
      length: e.length,
      language: e.language || null,
      url: e.url || null
    })),
    raw: m
  };

  console.log(JSON.stringify(out, null, 2));
  await client.disconnect();
})().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
