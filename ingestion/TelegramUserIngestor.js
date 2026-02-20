const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
const { Database } = require('../db/Database');

class TelegramUserIngestor {
  constructor(opts) {
    this.apiId = Number(opts.apiId);
    this.apiHash = opts.apiHash;
    this.phone = opts.phone;
    this.db = new Database(opts.dbPath);
    this.chatId = String(opts.chatId);
    this.topicId = opts.topicId ? Number(opts.topicId) : null;
    this.sessionPath = opts.sessionPath || path.join(process.cwd(), 'data/telegram_user.session');

    const sessionString = fs.existsSync(this.sessionPath)
      ? fs.readFileSync(this.sessionPath, 'utf8').trim()
      : '';
    this.client = new TelegramClient(new StringSession(sessionString), this.apiId, this.apiHash, {
      connectionRetries: 5,
    });
  }

  async start() {
    await this.client.start({
      phoneNumber: async () => this.phone || await input.text('Phone number (+1...): '),
      password: async () => await input.text('2FA password (if enabled): '),
      phoneCode: async () => await input.text('Telegram login code: '),
      onError: (err) => console.error('[MTProto] login error:', err.message),
    });

    fs.mkdirSync(path.dirname(this.sessionPath), { recursive: true });
    fs.writeFileSync(this.sessionPath, this.client.session.save(), 'utf8');
    console.log('[MTProto] Logged in. Session saved:', this.sessionPath);
  }

  _stateKey() {
    return `mtproto_last_id:${this.chatId}:${this.topicId || 'all'}`;
  }

  _getLastId() {
    this.db.db.exec(`CREATE TABLE IF NOT EXISTS poller_state (key TEXT PRIMARY KEY, value TEXT)`);
    const row = this.db.db.prepare('SELECT value FROM poller_state WHERE key = ?').get(this._stateKey());
    return row ? Number(row.value) : 0;
  }

  _setLastId(id) {
    this.db.db.prepare('INSERT OR REPLACE INTO poller_state (key, value) VALUES (?, ?)').run(this._stateKey(), String(id));
  }

  _inTopic(msg) {
    if (!this.topicId) return true;
    const topId = msg.replyTo?.replyToTopId || null;
    return topId === this.topicId || msg.id === this.topicId;
  }

  _toDbMessage(msg) {
    const chatId = String(msg.chatId || this.chatId);
    const fromId = msg.senderId ? String(msg.senderId) : 'unknown';
    const replyToMsgId = msg.replyTo?.replyToMsgId || null;
    const forumTopic = Boolean(msg.replyTo?.forumTopic);
    const topicId = msg.replyTo?.replyToTopId
      ? String(msg.replyTo.replyToTopId)
      : (forumTopic && replyToMsgId ? String(replyToMsgId) : null);

    return {
      id: `tg:${chatId}:${msg.id}`,
      source: 'telegram',
      channel: topicId || chatId,
      chatId,
      topicId,
      senderId: fromId,
      senderName: msg.sender?.firstName || msg.sender?.username || null,
      senderRole: 'user',
      replyToId: replyToMsgId ? `tg:${chatId}:${replyToMsgId}` : null,
      content: msg.message || '[media]',
      contentType: msg.message ? 'text' : 'other',
      timestamp: (() => {
        if (!msg.date) return Date.now();
        // gramjs may return Date, unix seconds, or string depending on context/version
        if (msg.date instanceof Date) return msg.date.getTime();
        if (typeof msg.date === 'number') return msg.date > 1e12 ? msg.date : msg.date * 1000;
        const parsed = new Date(msg.date).getTime();
        return Number.isFinite(parsed) ? parsed : Date.now();
      })(),
      rawMeta: {
        id: msg.id,
        chat_id: chatId,
        topic_id: topicId,
        forum_topic: forumTopic,
        reply_to_msg_id: replyToMsgId,
        reply_to_top_id: msg.replyTo?.replyToTopId || null,
      },
    };
  }

  async syncOnce({ backfillLimit = 200 } = {}) {
    const entity = await this.client.getEntity(this.chatId);
    const lastId = this._getLastId();
    let maxSeen = lastId;
    let ingested = 0;

    // If we already have a checkpoint, ask Telegram for only newer messages via minId.
    // This is robust across all topics in the same chat because message ids are chat-global.
    const normalizedLimit = Number(backfillLimit);
    const unlimitedBackfill = !Number.isFinite(normalizedLimit) || normalizedLimit <= 0;

    const iterOpts = lastId
      ? { minId: lastId, reverse: true }
      : (unlimitedBackfill
          ? { reverse: true }
          : { limit: normalizedLimit, reverse: true });

    for await (const msg of this.client.iterMessages(entity, iterOpts)) {
      if (!msg || !msg.id) continue;
      if (!this._inTopic(msg)) continue;
      if (lastId && msg.id <= lastId) continue; // safety guard

      const dbMsg = this._toDbMessage(msg);
      this.db.insertMessage(dbMsg);
      ingested++;
      if (msg.id > maxSeen) maxSeen = msg.id;
    }

    if (maxSeen > lastId) this._setLastId(maxSeen);
    console.log(`[MTProto] sync complete. Ingested: ${ingested}, lastId: ${maxSeen}`);
    return { ingested, lastId: maxSeen };
  }

  async runLoop({ intervalMs = 5000 } = {}) {
    console.log('[MTProto] Continuous sync loop started');
    while (true) {
      try {
        await this.syncOnce({ backfillLimit: 200 });
      } catch (e) {
        console.error('[MTProto] sync error:', e.message);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
}

module.exports = { TelegramUserIngestor };
