const BetterSqlite3 = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

class Database {
  #hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  constructor(dbPath) {
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    this.db.exec(schema);

    // Lightweight forward migrations for existing DBs.
    const cols = this.db.prepare(`PRAGMA table_info(messages)`).all().map(c => c.name);
    if (!cols.includes('chat_id')) this.db.exec(`ALTER TABLE messages ADD COLUMN chat_id TEXT`);
    if (!cols.includes('topic_id')) this.db.exec(`ALTER TABLE messages ADD COLUMN topic_id TEXT`);
    if (!cols.includes('media_path')) this.db.exec(`ALTER TABLE messages ADD COLUMN media_path TEXT`);
    if (!cols.includes('media_mime')) this.db.exec(`ALTER TABLE messages ADD COLUMN media_mime TEXT`);
    if (!cols.includes('media_size')) this.db.exec(`ALTER TABLE messages ADD COLUMN media_size INTEGER`);
    if (!cols.includes('media_width')) this.db.exec(`ALTER TABLE messages ADD COLUMN media_width INTEGER`);
    if (!cols.includes('media_height')) this.db.exec(`ALTER TABLE messages ADD COLUMN media_height INTEGER`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_scope ON messages(source, chat_id, topic_id)`);

    const topicCols = this.db.prepare(`PRAGMA table_info(topics)`).all().map(c => c.name);
    if (!topicCols.includes('archived')) this.db.exec(`ALTER TABLE topics ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
    if (!topicCols.includes('deleted_at')) this.db.exec(`ALTER TABLE topics ADD COLUMN deleted_at INTEGER`);
    if (!topicCols.includes('created_at')) this.db.exec(`ALTER TABLE topics ADD COLUMN created_at INTEGER`);
    if (!topicCols.includes('updated_at')) this.db.exec(`ALTER TABLE topics ADD COLUMN updated_at INTEGER`);

    // Backfill nullable/additive topic lifecycle timestamps safely for older SQLite builds
    // (ALTER TABLE ADD COLUMN only allows constant defaults).
    this.db.exec(`UPDATE topics SET created_at = COALESCE(created_at, CAST(unixepoch() * 1000 AS INTEGER))`);
    this.db.exec(`UPDATE topics SET updated_at = COALESCE(updated_at, CAST(unixepoch() * 1000 AS INTEGER))`);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_topics_archived_deleted ON topics(archived, deleted_at)`);

    this.#normalizeTelegramScopes();
  }

  #buildTopicUUID(source, externalContainerId, externalTopicId) {
    return `topic:${source}:${externalContainerId}:${externalTopicId}`;
  }

  #normalizeTelegramScopes() {
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
      INSERT INTO messages (id, source, channel, chat_id, topic_id, sender_id, sender_name, sender_role, reply_to_id, content, content_type, media_path, media_mime, media_size, media_width, media_height, timestamp, raw_meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        channel      = COALESCE(excluded.channel, messages.channel),
        chat_id      = COALESCE(messages.chat_id, excluded.chat_id),
        topic_id     = COALESCE(messages.topic_id, excluded.topic_id),
        sender_name  = COALESCE(excluded.sender_name, messages.sender_name),
        sender_role  = COALESCE(excluded.sender_role, messages.sender_role),
        reply_to_id  = COALESCE(excluded.reply_to_id, messages.reply_to_id),
        content      = COALESCE(excluded.content, messages.content),
        content_type = COALESCE(excluded.content_type, messages.content_type),
        media_path   = COALESCE(excluded.media_path, messages.media_path),
        media_mime   = COALESCE(excluded.media_mime, messages.media_mime),
        media_size   = COALESCE(excluded.media_size, messages.media_size),
        media_width  = COALESCE(excluded.media_width, messages.media_width),
        media_height = COALESCE(excluded.media_height, messages.media_height),
        timestamp    = COALESCE(excluded.timestamp, messages.timestamp),
        raw_meta     = COALESCE(excluded.raw_meta, messages.raw_meta)
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
      msg.mediaPath || null,
      msg.mediaMime || null,
      Number.isFinite(msg.mediaSize) ? msg.mediaSize : null,
      Number.isFinite(msg.mediaWidth) ? msg.mediaWidth : null,
      Number.isFinite(msg.mediaHeight) ? msg.mediaHeight : null,
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
   * List distinct channels/scopes for a source.
   */
  getChannels(source) {
    return this.db.prepare(
      `SELECT DISTINCT COALESCE(topic_id, chat_id, channel) AS scope
       FROM messages
       WHERE source = ?
       ORDER BY scope`
    ).all(source).map(r => r.scope);
  }

  getOrCreateTopicUUID(source, externalContainerId, externalTopicId) {
    const src = String(source);
    const container = String(externalContainerId);
    const topic = String(externalTopicId);

    // Canonical path: generate source-adapted topic UUID first, then query by topic_uuid.
    const topicUUID = this.#buildTopicUUID(src, container, topic);
    const byUUID = this.db.prepare(
      `SELECT topic_uuid FROM topics WHERE topic_uuid=?`
    ).get(topicUUID);
    if (byUUID?.topic_uuid) return String(byUUID.topic_uuid);

    this.db.prepare(
      `INSERT OR IGNORE INTO topics(topic_uuid, source, external_container_id, external_topic_id, archived, deleted_at, created_at, updated_at)
       VALUES(?, ?, ?, ?, 0, NULL, (unixepoch() * 1000), (unixepoch() * 1000))`
    ).run(topicUUID, src, container, topic);

    return topicUUID;
  }

  getTopicByUUID(topicUUID) {
    return this.db.prepare(`SELECT * FROM topics WHERE topic_uuid=?`).get(String(topicUUID)) || null;
  }

  setTopicArchived(topicUUID, archived) {
    return this.db.prepare(
      `UPDATE topics
       SET archived=?, updated_at=(unixepoch() * 1000)
       WHERE topic_uuid=?`
    ).run(archived ? 1 : 0, String(topicUUID));
  }

  setTopicDeletedAt(topicUUID, deletedAtMs) {
    return this.db.prepare(
      `UPDATE topics
       SET deleted_at=?, updated_at=(unixepoch() * 1000)
       WHERE topic_uuid=?`
    ).run(deletedAtMs, String(topicUUID));
  }

  /**
   * List telegram topics under one chat, ordered by most recent message desc.
   */
  getTelegramTopics(chatId, { includeArchived = false } = {}) {
    const rows = this.db.prepare(
      `SELECT topic_id, MAX(timestamp) AS last_ts, COUNT(*) AS msg_count
       FROM messages
       WHERE source='telegram' AND chat_id=? AND topic_id IS NOT NULL
       GROUP BY topic_id
       ORDER BY last_ts DESC`
    ).all(String(chatId));

    const titleFromMetaStmt = this.db.prepare(
      `SELECT raw_meta FROM messages
       WHERE source='telegram' AND chat_id=? AND topic_id=? AND raw_meta LIKE '%"topic_title"%'
       ORDER BY timestamp ASC LIMIT 1`
    );
    const firstTextStmt = this.db.prepare(
      `SELECT content FROM messages
       WHERE source='telegram' AND chat_id=? AND topic_id=? AND content IS NOT NULL AND content != '' AND content != '[media]'
       ORDER BY timestamp ASC LIMIT 1`
    );

    const out = [];
    for (const r of rows) {
      const topicUUID = this.getOrCreateTopicUUID('telegram', String(chatId), String(r.topic_id));
      const topicRow = this.getTopicByUUID(topicUUID);
      const archived = Number(topicRow?.archived || 0) === 1;
      const deletedAt = topicRow?.deleted_at || null;
      if (!includeArchived && archived) continue;

      let name = null;
      for (const rr of titleFromMetaStmt.all(String(chatId), String(r.topic_id))) {
        try {
          const meta = rr.raw_meta ? JSON.parse(rr.raw_meta) : {};
          const t = meta.topic_title || meta.forum_topic_title || null;
          if (t && String(t).trim()) { name = String(t).trim(); break; }
        } catch {}
      }
      if (!name) {
        const first = firstTextStmt.get(String(chatId), String(r.topic_id));
        name = first?.content?.trim() || null;
      }
      if (!name || name === '[media]') name = `Topic ${r.topic_id}`;

      out.push({
        id: String(r.topic_id),
        topicUUID,
        name: name.length > 60 ? name.slice(0, 60) + '…' : name,
        lastTimestamp: r.last_ts,
        messageCount: r.msg_count,
        archived,
        deletedAt,
      });
    }

    return out;
  }

  /**
   * List distinct sources.
   */
  getSources() {
    return this.db.prepare(
      'SELECT DISTINCT source FROM messages ORDER BY source'
    ).all().map(r => r.source);
  }

  getPrimaryTelegramChatId() {
    const row = this.db.prepare(
      `SELECT chat_id, COUNT(*) cnt
       FROM messages
       WHERE source='telegram' AND chat_id IS NOT NULL
       GROUP BY chat_id
       ORDER BY cnt DESC
       LIMIT 1`
    ).get();
    return row ? String(row.chat_id) : null;
  }

  getTopicByTelegramScope(chatId, topicId) {
    return this.db.prepare(
      `SELECT * FROM topics
       WHERE source='telegram' AND external_container_id=? AND external_topic_id=?`
    ).get(String(chatId), String(topicId)) || null;
  }

  isTelegramTopicDeleted(chatId, topicId) {
    const row = this.getTopicByTelegramScope(chatId, topicId);
    return !!(row && row.deleted_at);
  }

  getChannelSignature(source, channel, limit = 80) {
    const scope = String(channel);
    const rows = this.db.prepare(
      `SELECT id, content, raw_meta, media_path, timestamp
       FROM messages
       WHERE source = ?
         AND (channel = ? OR topic_id = ? OR chat_id = ?)
       ORDER BY timestamp DESC, id DESC
       LIMIT ?`
    ).all(source, scope, scope, scope, Number(limit));

    const payload = rows
      .map((r) => `${r.id}|${r.timestamp || ''}|${r.content || ''}|${r.media_path || ''}|${r.raw_meta || ''}`)
      .join('\n');

    return this.#hashString(payload);
  }

  upsertLayers(source, channel, layers = []) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO layers (layer_uuid, source, channel, first_message_id, parent_layer_uuid, done, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, COALESCE((SELECT done FROM layers WHERE layer_uuid = ?), 0), ?, ?)
      ON CONFLICT(layer_uuid) DO UPDATE SET
        source = excluded.source,
        channel = excluded.channel,
        first_message_id = COALESCE(excluded.first_message_id, layers.first_message_id),
        parent_layer_uuid = excluded.parent_layer_uuid,
        updated_at = excluded.updated_at
    `);

    const tx = this.db.transaction((items) => {
      for (const l of items) {
        if (!l?.id) continue;
        stmt.run(
          String(l.id),
          String(source),
          String(channel),
          l.firstMessageId ? String(l.firstMessageId) : null,
          l.parentLayerUuid ? String(l.parentLayerUuid) : null,
          String(l.id),
          now,
          now,
        );
      }
    });
    tx(layers);
  }

  getLayerStatuses(source, channel) {
    return this.db.prepare(
      `SELECT layer_uuid, done, updated_at
       FROM layers
       WHERE source=? AND channel=?`
    ).all(String(source), String(channel));
  }

  setLayerDone(source, channel, layerUuid, done) {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO layers (layer_uuid, source, channel, done, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(layer_uuid) DO UPDATE SET
         done=excluded.done,
         source=excluded.source,
         channel=excluded.channel,
         updated_at=excluded.updated_at`
    ).run(String(layerUuid), String(source), String(channel), done ? 1 : 0, now, now);

    return { ok: true, layerUuid: String(layerUuid), done: !!done, updatedAt: now };
  }

  close() {
    this.db.close();
  }
}

module.exports = { Database };
