const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

class TelegramSender {
  constructor({ apiId, apiHash, sessionPath, connectionRetries = 5 } = {}) {
    this.apiId = Number(apiId || process.env.TG_API_ID || process.env.TELEGRAM_API_ID);
    this.apiHash = apiHash || process.env.TG_API_HASH || process.env.TELEGRAM_API_HASH;
    this.sessionPath = sessionPath || process.env.TG_SESSION_PATH || path.join(process.cwd(), 'data/telegram_user.session');
    this.connectionRetries = connectionRetries;

    this.client = null;
    this.connected = false;
  }

  async #ensureClient() {
    if (this.connected && this.client) return;

    if (!this.apiId || !this.apiHash) {
      throw new Error('missing TG_API_ID/TG_API_HASH');
    }

    const sessionStr = fs.existsSync(this.sessionPath)
      ? fs.readFileSync(this.sessionPath, 'utf8').trim()
      : '';

    if (!sessionStr) {
      throw new Error(`missing Telegram session file: ${this.sessionPath}`);
    }

    this.client = new TelegramClient(new StringSession(sessionStr), this.apiId, this.apiHash, {
      connectionRetries: this.connectionRetries,
    });

    await this.client.connect();
    this.connected = true;
  }

  async sendText({ chatId, text, replyToId } = {}) {
    if (!chatId) throw new Error('chatId required');
    if (!text || !String(text).trim()) throw new Error('text required');

    await this.#ensureClient();

    const entity = await this.client.getEntity(String(chatId));
    const resolvedReplyTo = (replyToId === undefined || replyToId === null || replyToId === '')
      ? null
      : Number(replyToId);
    if (resolvedReplyTo !== null && !Number.isFinite(resolvedReplyTo)) {
      throw new Error('replyToId must be a numeric Telegram message id');
    }

    const payload = {
      message: String(text),
    };
    if (resolvedReplyTo) payload.replyTo = resolvedReplyTo;

    const sent = await this.client.sendMessage(entity, payload);

    return {
      ok: true,
      telegramMessageId: Number(sent?.id),
      chatId: String(chatId),
      replyToId: resolvedReplyTo,
    };
  }

  async close() {
    if (this.client && this.connected) {
      await this.client.disconnect();
    }
    this.connected = false;
  }
}

module.exports = { TelegramSender };
