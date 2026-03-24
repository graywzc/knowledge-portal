const fs = require('fs');
const path = require('path');
const { TelegramClient, Api } = require('telegram');
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

  async createTopic({ chatId, title } = {}) {
    if (!chatId) throw new Error('chatId required');
    if (!title || !String(title).trim()) throw new Error('title required');

    await this.#ensureClient();

    const entity = await this.client.getEntity(String(chatId));
    const result = await this.client.invoke(new Api.channels.CreateForumTopic({
      channel: entity,
      title: String(title).trim(),
    }));

    let topicId = null;
    const normalizedTitle = String(title).trim();
    const updates = Array.isArray(result?.updates) ? result.updates : [];
    const candidates = [];

    for (const u of updates) {
      const m = u?.message || u?.messagePeer || null;
      const action = m?.action || null;
      if (action?.className !== 'MessageActionTopicCreate') continue;
      const id = Number(m?.id);
      if (!Number.isFinite(id)) continue;
      candidates.push({
        id,
        title: action?.title ? String(action.title).trim() : null,
      });
    }

    const exact = candidates.find((c) => c.title === normalizedTitle);
    if (exact) topicId = exact.id;
    else if (candidates.length) topicId = candidates[candidates.length - 1].id;

    return {
      ok: true,
      chatId: String(chatId),
      title: String(title).trim(),
      topicId,
    };
  }

  async deleteTopic({ chatId, topicId } = {}) {
    if (!chatId) throw new Error('chatId required');
    if (topicId === undefined || topicId === null || topicId === '') throw new Error('topicId required');
    const resolvedTopicId = Number(topicId);
    if (!Number.isFinite(resolvedTopicId)) throw new Error('topicId required');

    await this.#ensureClient();

    const entity = await this.client.getEntity(String(chatId));
    await this.client.invoke(new Api.channels.DeleteTopicHistory({
      channel: entity,
      topMsgId: resolvedTopicId,
    }));

    return {
      ok: true,
      chatId: String(chatId),
      topicId: resolvedTopicId,
    };
  }

  async sendImage({ chatId, imageBuffer, mimeType = 'image/png', caption = '', replyToId } = {}) {
    if (!chatId) throw new Error('chatId required');
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
      throw new Error('imageBuffer required');
    }

    await this.#ensureClient();

    const entity = await this.client.getEntity(String(chatId));
    const resolvedReplyTo = (replyToId === undefined || replyToId === null || replyToId === '')
      ? null
      : Number(replyToId);
    if (resolvedReplyTo !== null && !Number.isFinite(resolvedReplyTo)) {
      throw new Error('replyToId must be a numeric Telegram message id');
    }

    const ext = mimeType.includes('jpeg') ? 'jpg' : (mimeType.split('/')[1] || 'png');
    const tmpPath = path.join(process.cwd(), `data/tmp-upload-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, imageBuffer);

    try {
      const payload = {
        file: tmpPath,
        caption: String(caption || ''),
      };
      if (resolvedReplyTo) payload.replyTo = resolvedReplyTo;

      const sent = await this.client.sendFile(entity, payload);
      return {
        ok: true,
        telegramMessageId: Number(sent?.id),
        chatId: String(chatId),
        replyToId: resolvedReplyTo,
      };
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
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
