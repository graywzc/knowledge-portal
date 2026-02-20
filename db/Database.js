const BetterSqlite3 = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

class Database {
  constructor(dbPath) {
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this._migrate();
  }

  _migrate() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    this.db.exec(schema);

    // Lightweight forward migrations for existing DBs.
    const cols = this.db.prepare(`PRAGMA table_info(messages)`).all().map(c => c.name);
    if (!cols.includes('chat_id')) this.db.exec(`ALTER TABLE messages ADD COLUMN chat_id TEXT`);
    if (!cols.includes('topic_id')) this.db.exec(`ALTER TABLE messages ADD COLUMN topic_id TEXT`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_scope ON messages(source, chat_id, topic_id)`);

    this._normalizeTelegramScopes();
  }

  _normalizeTelegramScopes() {
    // Backfill chat_id/topic_id for existing telegram rows and align channel with topic/chat scope.
    const rows = this.db.prepare(
      `SELECT id, channel, raw_meta FROM messages WHERE source='telegram' AND (chat_id IS NULL OR chat_id='' OR topic_id IS NULL)`
    ).all();

    const upd = this.db.prepare(`
      UPDATE messages
      SET chat_id = ?, topic_id = ?, channel = ?
      WHERE id = ?
    `);

    const tx = this.db.transaction((items) => {
      for (const r of items) {
        let meta = {};
        try { meta = r.raw_meta ? JSON.parse(r.raw_meta) : {}; } catch {}

        const chatId = String(meta.chat_id || r.channel || '');
        const topicRaw =
          meta.message_thread_id ??
          meta.reply_to_top_id ??
          (meta.forum_topic ? meta.reply_to_msg_id : null) ??
          meta.topic_id ??
          null;
        const topicId = (topicRaw === null || topicRaw === undefined || topicRaw === '') ? null : String(topicRaw);
        const scope = topicId || chatId || r.channel;

        upd.run(chatId || null, topicId, scope, r.id);
      }
    });

    if (rows.length) tx(rows);
  }

  /**
   * Insert a message. Idempotent (ignores duplicates by id).
   */
  insertMessage(msg) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, source, channel, chat_id, topic_id, sender_id, sender_name, sender_role, reply_to_id, content, content_type, timestamp, raw_meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        channel   = COALESCE(excluded.channel, messages.channel),
        chat_id   = COALESCE(messages.chat_id, excluded.chat_id),
        topic_id  = COALESCE(messages.topic_id, excluded.topic_id),
        raw_meta  = COALESCE(excluded.raw_meta, messages.raw_meta)
    `);
    const chatId = msg.chatId ? String(msg.chatId) : null;
    const topicId = (msg.topicId === null || msg.topicId === undefined || msg.topicId === '') ? null : String(msg.topicId);
    const scope = msg.channel || topicId || chatId;

    return stmt.run(
      msg.id,
      msg.source,
      scope,
      chatId,
      topicId,
      msg.senderId,
      msg.senderName || null,
      msg.senderRole || 'user',
      msg.replyToId || null,
      msg.content,
      msg.contentType || 'text',
      msg.timestamp,
      msg.rawMeta ? JSON.stringify(msg.rawMeta) : null,
    );
  }

  /**
   * Insert multiple messages in a transaction.
   */
  insertMessages(msgs) {
    const tx = this.db.transaction((messages) => {
      for (const msg of messages) {
        this.insertMessage(msg);
      }
    });
    tx(msgs);
  }

  /**
   * Get all messages for a source+channel, ordered by timestamp.
   */
  getMessages(source, channel) {
    const scope = String(channel);
    return this.db.prepare(
      `SELECT * FROM messages
       WHERE source = ?
         AND (channel = ? OR topic_id = ? OR chat_id = ?)
       ORDER BY timestamp ASC`
    ).all(source, scope, scope, scope);
  }

  /**
   * Get a single message by id.
   */
  getMessage(id) {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  }

  /**
   * List distinct channels for a source.
   */
  getChannels(source) {
    return this.db.prepare(
      `SELECT DISTINCT COALESCE(topic_id, chat_id, channel) AS scope
       FROM messages
       WHERE source = ?
       ORDER BY scope`
    ).all(source).map(r => r.scope);
  }

  /**
   * List distinct sources.
   */
  getSources() {
    return this.db.prepare(
      'SELECT DISTINCT source FROM messages ORDER BY source'
    ).all().map(r => r.source);
  }

  close() {
    this.db.close();
  }
}

module.exports = { Database };
