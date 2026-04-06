const BetterSqlite3 = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KP_NAMESPACE = '0a0c7bd1-9a5e-4f13-b0bd-67a7847f3a22';

function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error('invalid UUID namespace');
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(buf) {
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function uuidv5(name, namespace = KP_NAMESPACE) {
  const ns = uuidToBytes(namespace);
  const hash = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(String(name), 'utf8')])).digest();
  const out = Buffer.from(hash.subarray(0, 16));
  out[6] = (out[6] & 0x0f) | 0x50;
  out[8] = (out[8] & 0x3f) | 0x80;
  return bytesToUuid(out);
}

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

    // Forward migrations for existing DBs — additive only.
    const cols = this.db.prepare(`PRAGMA table_info(messages)`).all().map(c => c.name);

    // Legacy columns (kept for backward compat, still written by TelegramUserIngestor)
    if (!cols.includes('chat_id'))       this.db.exec(`ALTER TABLE messages ADD COLUMN chat_id TEXT`);
    if (!cols.includes('topic_id'))      this.db.exec(`ALTER TABLE messages ADD COLUMN topic_id TEXT`);
    if (!cols.includes('channel'))       this.db.exec(`ALTER TABLE messages ADD COLUMN channel TEXT`);
    if (!cols.includes('reply_to_id'))   this.db.exec(`ALTER TABLE messages ADD COLUMN reply_to_id TEXT`);
    if (!cols.includes('reply_to_locked')) this.db.exec(`ALTER TABLE messages ADD COLUMN reply_to_locked INTEGER NOT NULL DEFAULT 0`);
    if (!cols.includes('media_path'))    this.db.exec(`ALTER TABLE messages ADD COLUMN media_path TEXT`);
    if (!cols.includes('media_mime'))    this.db.exec(`ALTER TABLE messages ADD COLUMN media_mime TEXT`);
    if (!cols.includes('media_size'))    this.db.exec(`ALTER TABLE messages ADD COLUMN media_size INTEGER`);
    if (!cols.includes('media_width'))   this.db.exec(`ALTER TABLE messages ADD COLUMN media_width INTEGER`);
    if (!cols.includes('media_height'))  this.db.exec(`ALTER TABLE messages ADD COLUMN media_height INTEGER`);
    if (!cols.includes('raw_meta'))      this.db.exec(`ALTER TABLE messages ADD COLUMN raw_meta TEXT`);

    // New columns
    if (!cols.includes('parent_id'))     this.db.exec(`ALTER TABLE messages ADD COLUMN parent_id TEXT`);
    if (!cols.includes('branched'))      this.db.exec(`ALTER TABLE messages ADD COLUMN branched INTEGER`);
    if (!cols.includes('meta'))          this.db.exec(`ALTER TABLE messages ADD COLUMN meta TEXT`);

    // Backfill parent_id from reply_to_id for existing rows
    this.db.exec(`UPDATE messages SET parent_id = reply_to_id WHERE parent_id IS NULL AND reply_to_id IS NOT NULL`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id)`);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_scope ON messages(source, chat_id, topic_id)`);

    // Topics — support both legacy (topic_uuid PK) and new (id = root message UUID)
    const topicCols = this.db.prepare(`PRAGMA table_info(topics)`).all().map(c => c.name);
    if (!topicCols.includes('topic_uuid') && !topicCols.includes('id')) {
      // Fresh DB already has new schema from schema.sql — nothing to do
    } else if (topicCols.includes('topic_uuid') && !topicCols.includes('parent_topic_id')) {
      // Legacy topics table — add new columns
      this.db.exec(`ALTER TABLE topics ADD COLUMN parent_topic_id TEXT`);
    }
    if (topicCols.includes('topic_uuid')) {
      if (!topicCols.includes('name'))       this.db.exec(`ALTER TABLE topics ADD COLUMN name TEXT`);
      if (!topicCols.includes('meta'))       this.db.exec(`ALTER TABLE topics ADD COLUMN meta TEXT`);
      if (!topicCols.includes('archived'))   this.db.exec(`ALTER TABLE topics ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
      if (!topicCols.includes('deleted_at')) this.db.exec(`ALTER TABLE topics ADD COLUMN deleted_at INTEGER`);
      if (!topicCols.includes('created_at')) this.db.exec(`ALTER TABLE topics ADD COLUMN created_at INTEGER`);
      if (!topicCols.includes('updated_at')) this.db.exec(`ALTER TABLE topics ADD COLUMN updated_at INTEGER`);
      this.db.exec(`UPDATE topics SET created_at = COALESCE(created_at, CAST(unixepoch() * 1000 AS INTEGER))`);
      this.db.exec(`UPDATE topics SET updated_at = COALESCE(updated_at, CAST(unixepoch() * 1000 AS INTEGER))`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_topics_archived_deleted ON topics(archived, deleted_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_topics_parent ON topics(parent_topic_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_topics_search ON topics(name) WHERE parent_topic_id IS NULL`);

    // Layers — support both legacy and new schema
    const layerCols = this.db.prepare(`PRAGMA table_info(layers)`).all().map(c => c.name);
    if (layerCols.includes('layer_uuid')) {
      // Legacy layers table
      if (!layerCols.includes('title'))          this.db.exec(`ALTER TABLE layers ADD COLUMN title TEXT`);
      if (!layerCols.includes('parent_layer_id')) this.db.exec(`ALTER TABLE layers ADD COLUMN parent_layer_id TEXT`);
    }

    this.#normalizeTelegramScopes();
  }

  // Detect which PK column the topics table uses (legacy = topic_uuid, new = id)
  #topicsHasLegacyPk() {
    const cols = this.db.prepare(`PRAGMA table_info(topics)`).all().map(c => c.name);
    return cols.includes('topic_uuid');
  }

  #normalizeTelegramScopes() {
    const rows = this.db.prepare(
      `SELECT id, channel, raw_meta FROM messages WHERE source='telegram' AND (chat_id IS NULL OR chat_id='' OR topic_id IS NULL)`
    ).all();

    const upd = this.db.prepare(`UPDATE messages SET chat_id = ?, topic_id = ?, channel = ? WHERE id = ?`);
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

  // --- Message ID helpers ---

  static messageId(naturalKey) {
    return uuidv5(naturalKey);
  }

  static telegramMessageId(chatId, msgId) {
    return uuidv5(`telegram:${chatId}:${msgId}`);
  }

  static claudeMessageId(hostname, encodedProject, sessionId, messageUuid) {
    return uuidv5(`claude:${hostname}:${encodedProject}:${sessionId}:${messageUuid}`);
  }

  // --- Messages ---

  insertMessage(msg) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO messages (
        id, source, sender_id, sender_name, sender_role,
        parent_id, branched, content, content_type, timestamp, meta, created_at,
        channel, chat_id, topic_id, reply_to_id, reply_to_locked,
        media_path, media_mime, media_size, media_width, media_height, raw_meta
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        sender_name  = COALESCE(excluded.sender_name, messages.sender_name),
        sender_role  = COALESCE(excluded.sender_role, messages.sender_role),
        content      = COALESCE(excluded.content, messages.content),
        content_type = COALESCE(excluded.content_type, messages.content_type),
        timestamp    = COALESCE(excluded.timestamp, messages.timestamp),
        meta         = COALESCE(excluded.meta, messages.meta),
        parent_id    = CASE WHEN messages.reply_to_locked THEN messages.parent_id
                            ELSE COALESCE(excluded.parent_id, messages.parent_id) END,
        branched     = COALESCE(messages.branched, excluded.branched),
        channel      = CASE WHEN messages.reply_to_locked THEN messages.channel
                            ELSE COALESCE(excluded.channel, messages.channel) END,
        chat_id      = COALESCE(messages.chat_id, excluded.chat_id),
        topic_id     = COALESCE(messages.topic_id, excluded.topic_id),
        reply_to_id  = CASE WHEN messages.reply_to_locked THEN messages.reply_to_id
                            ELSE COALESCE(excluded.reply_to_id, messages.reply_to_id) END,
        media_path   = COALESCE(excluded.media_path, messages.media_path),
        media_mime   = COALESCE(excluded.media_mime, messages.media_mime),
        media_size   = COALESCE(excluded.media_size, messages.media_size),
        media_width  = COALESCE(excluded.media_width, messages.media_width),
        media_height = COALESCE(excluded.media_height, messages.media_height),
        raw_meta     = COALESCE(excluded.raw_meta, messages.raw_meta)
    `);

    const chatId = msg.chatId ? String(msg.chatId) : null;
    const topicId = (msg.topicId === null || msg.topicId === undefined || msg.topicId === '') ? null : String(msg.topicId);
    const scope = msg.channel || topicId || chatId || msg.source || 'unknown';
    const meta = msg.meta ? (typeof msg.meta === 'string' ? msg.meta : JSON.stringify(msg.meta)) : null;
    const rawMeta = msg.rawMeta ? (typeof msg.rawMeta === 'string' ? msg.rawMeta : JSON.stringify(msg.rawMeta)) : null;

    const inserted = stmt.run(
      msg.id,
      msg.source,
      msg.senderId,
      msg.senderName || null,
      msg.senderRole || 'user',
      msg.parentId || null,
      msg.branched !== undefined && msg.branched !== null ? (msg.branched ? 1 : 0) : null,
      msg.content,
      msg.contentType || 'text',
      msg.timestamp,
      meta,
      now,
      scope || null,
      chatId,
      topicId,
      msg.replyToId || null,
      msg.replyToLocked ? 1 : 0,
      msg.mediaPath || null,
      msg.mediaMime || null,
      Number.isFinite(msg.mediaSize) ? msg.mediaSize : null,
      Number.isFinite(msg.mediaWidth) ? msg.mediaWidth : null,
      Number.isFinite(msg.mediaHeight) ? msg.mediaHeight : null,
      rawMeta,
    );

    this.#touchTopicUpdatedAt({ source: msg.source, chatId, topicId, timestamp: msg.timestamp });
    this.#touchLayerUpdatedAt({ source: msg.source, chatId, topicId });

    return inserted;
  }

  insertMessages(msgs) {
    const tx = this.db.transaction((messages) => {
      for (const msg of messages) this.insertMessage(msg);
    });
    tx(msgs);
  }

  getMessage(id) {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  }

  deleteMessage(id) {
    return this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  }

  getMessages(source, channel) {
    const scope = String(channel);
    return this.db.prepare(
      `SELECT * FROM messages
       WHERE source = ?
         AND (channel = ? OR topic_id = ? OR chat_id = ?)
       ORDER BY timestamp ASC`
    ).all(source, scope, scope, scope);
  }

  getMessagesByTimeRange({ since, until, source } = {}) {
    const conditions = [];
    const params = [];
    if (since != null)  { conditions.push('timestamp >= ?'); params.push(Number(since)); }
    if (until != null)  { conditions.push('timestamp <= ?'); params.push(Number(until)); }
    if (source != null) { conditions.push('source = ?');     params.push(String(source)); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM messages ${where} ORDER BY timestamp ASC`).all(...params);
  }

  updateParent(id, newParentId, newBranched) {
    const updates = ['parent_id = ?', 'reply_to_locked = 1'];
    const params = [newParentId || null];
    if (newBranched !== undefined) {
      updates.push('branched = ?');
      params.push(newBranched !== null ? (newBranched ? 1 : 0) : null);
    }
    params.push(id);
    return this.db.prepare(`UPDATE messages SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  getSources() {
    return this.db.prepare('SELECT DISTINCT source FROM messages ORDER BY source').all().map(r => r.source);
  }

  getChannels(source) {
    return this.db.prepare(
      `SELECT DISTINCT COALESCE(topic_id, chat_id, channel) AS scope
       FROM messages WHERE source = ? ORDER BY scope`
    ).all(source).map(r => r.scope);
  }

  getPrimaryTelegramChatId() {
    const row = this.db.prepare(
      `SELECT chat_id, COUNT(*) cnt FROM messages
       WHERE source='telegram' AND chat_id IS NOT NULL
       GROUP BY chat_id ORDER BY cnt DESC LIMIT 1`
    ).get();
    return row ? String(row.chat_id) : null;
  }

  getChannelSignature(source, channel, limit = 80) {
    const scope = String(channel);
    const rows = this.db.prepare(
      `SELECT id, content, meta, raw_meta, media_path, timestamp
       FROM messages
       WHERE source = ? AND (channel = ? OR topic_id = ? OR chat_id = ?)
       ORDER BY timestamp DESC, id DESC LIMIT ?`
    ).all(source, scope, scope, scope, Number(limit));
    const payload = rows
      .map(r => `${r.id}|${r.timestamp || ''}|${r.content || ''}|${r.media_path || ''}|${r.raw_meta || ''}|${r.meta || ''}`)
      .join('\n');
    return this.#hashString(payload);
  }

  // --- Topics ---

  #legacyTopicPkCol() {
    return this.#topicsHasLegacyPk() ? 'topic_uuid' : 'id';
  }

  upsertTopic({ id, name, meta, parentTopicId, updatedAt } = {}) {
    const now = Date.now();
    const ts = updatedAt || now;
    const metaStr = meta ? (typeof meta === 'string' ? meta : JSON.stringify(meta)) : null;
    if (this.#topicsHasLegacyPk()) {
      // Legacy DB: topics keyed by topic_uuid. Use id as topic_uuid.
      this.db.prepare(
        `INSERT OR IGNORE INTO topics(topic_uuid, source, name, meta, parent_topic_id, archived, deleted_at, created_at, updated_at)
         VALUES(?, 'claude', ?, ?, ?, 0, NULL, ?, ?)`
      ).run(id, name || null, metaStr, parentTopicId || null, now, ts);
      this.db.prepare(
        `UPDATE topics SET name = COALESCE(?, name), updated_at = ? WHERE topic_uuid = ?`
      ).run(name || null, ts, id);
    } else {
      this.db.prepare(
        `INSERT OR IGNORE INTO topics(id, name, meta, parent_topic_id, archived, deleted_at, created_at, updated_at)
         VALUES(?, ?, ?, ?, 0, NULL, ?, ?)`
      ).run(id, name || null, metaStr, parentTopicId || null, now, ts);
      this.db.prepare(
        `UPDATE topics SET name = COALESCE(?, name), updated_at = ? WHERE id = ?`
      ).run(name || null, ts, id);
    }
  }

  /** Set topics.updated_at = MAX(messages.timestamp) for the given session. */
  touchTopicTimestamp(topicId, sessionId) {
    const pkCol = this.#legacyTopicPkCol();
    const row = this.db.prepare(
      `SELECT MAX(timestamp) AS max_ts FROM messages WHERE source = 'claude' AND topic_id = ?`
    ).get(sessionId);
    const maxTs = row?.max_ts;
    if (!maxTs) return;
    this.db.prepare(
      `UPDATE topics SET updated_at = ? WHERE ${pkCol} = ?`
    ).run(maxTs, topicId);
  }

  // Legacy Telegram topic helpers (kept for backward compat)
  #buildTopicUUID(source, externalContainerId, externalTopicId) {
    const canonicalInput = `${String(source).trim().toLowerCase()}|container=${String(externalContainerId).trim()}|topic=${String(externalTopicId).trim()}`;
    return uuidv5(canonicalInput);
  }

  getOrCreateTopicUUID(source, externalContainerId, externalTopicId) {
    const topicUUID = this.#buildTopicUUID(source, externalContainerId, externalTopicId);
    const pkCol = this.#legacyTopicPkCol();
    const existing = this.db.prepare(`SELECT ${pkCol} FROM topics WHERE ${pkCol}=?`).get(topicUUID);
    if (existing) return String(existing[pkCol]);
    const meta = JSON.stringify({ source: String(source), containerId: String(externalContainerId), topicId: String(externalTopicId) });
    const now = Date.now();
    if (this.#topicsHasLegacyPk()) {
      this.db.prepare(
        `INSERT OR IGNORE INTO topics(topic_uuid, source, name, meta, archived, deleted_at, created_at, updated_at)
         VALUES(?, ?, NULL, ?, 0, NULL, ?, ?)`
      ).run(topicUUID, String(source), meta, now, now);
    } else {
      this.db.prepare(
        `INSERT OR IGNORE INTO topics(id, name, meta, archived, deleted_at, created_at, updated_at)
         VALUES(?, NULL, ?, 0, NULL, ?, ?)`
      ).run(topicUUID, meta, now, now);
    }
    return topicUUID;
  }

  getTopicByUUID(topicUUID) {
    const pkCol = this.#legacyTopicPkCol();
    const row = this.db.prepare(`SELECT * FROM topics WHERE ${pkCol}=?`).get(String(topicUUID)) || null;
    if (!row) return null;
    let meta = null;
    try { meta = row.meta ? JSON.parse(row.meta) : null; } catch { meta = null; }
    return { ...row, topic_uuid: row.topic_uuid || row.id, meta };
  }

  getTopicByTelegramScope(chatId, topicId) {
    return this.getTopicByUUID(this.#buildTopicUUID('telegram', String(chatId), String(topicId)));
  }

  isTelegramTopicDeleted(chatId, topicId) {
    const row = this.getTopicByTelegramScope(chatId, topicId);
    return !!(row && row.deleted_at);
  }

  resolveTopicScopeByUUID(topicUUID) {
    const topic = this.getTopicByUUID(topicUUID);
    if (!topic) return null;
    const src = String(topic.source || topic.meta?.source || '');
    if (src === 'telegram') {
      const chatId = topic.meta?.chatId || topic.meta?.containerId || null;
      const topicId = topic.meta?.topicId || null;
      if (!chatId || !topicId) return null;
      return {
        topicUUID: String(topic.topic_uuid || topic.id),
        source: 'telegram',
        name: topic.name || null,
        locator: { chatId: String(chatId), topicId: String(topicId), channel: String(topicId) },
        createdAt: topic.created_at ? Number(topic.created_at) : null,
        updatedAt: topic.updated_at ? Number(topic.updated_at) : null,
        archived: !!topic.archived,
        deletedAt: topic.deleted_at ? Number(topic.deleted_at) : null,
      };
    }
    if (src === 'claude') {
      const sessionId = topic.meta?.session_id || null;
      if (!sessionId) return null;
      return {
        topicUUID: String(topic.topic_uuid || topic.id),
        source: 'claude',
        name: topic.name || null,
        locator: {
          channel: sessionId,
          sessionId,
          hostname: topic.meta?.hostname || null,
          encodedProject: topic.meta?.encoded_project || null,
          cwd: topic.meta?.cwd || null,
          gitBranch: topic.meta?.git_branch || null,
        },
        createdAt: topic.created_at ? Number(topic.created_at) : null,
        updatedAt: topic.updated_at ? Number(topic.updated_at) : null,
        archived: !!topic.archived,
        deletedAt: topic.deleted_at ? Number(topic.deleted_at) : null,
      };
    }
    return null;
  }

  setTopicArchived(topicUUID, archived) {
    const pkCol = this.#legacyTopicPkCol();
    return this.db.prepare(`UPDATE topics SET archived=?, updated_at=(unixepoch() * 1000) WHERE ${pkCol}=?`)
      .run(archived ? 1 : 0, String(topicUUID));
  }

  setTopicDeletedAt(topicUUID, deletedAtMs) {
    const pkCol = this.#legacyTopicPkCol();
    return this.db.prepare(`UPDATE topics SET deleted_at=?, updated_at=(unixepoch() * 1000) WHERE ${pkCol}=?`)
      .run(deletedAtMs, String(topicUUID));
  }

  getTelegramTopics(chatId, { includeArchived = false } = {}) {
    const rows = this.db.prepare(
      `SELECT topic_id, MAX(timestamp) AS last_ts, COUNT(*) AS msg_count
       FROM messages WHERE source='telegram' AND chat_id=? AND topic_id IS NOT NULL
       GROUP BY topic_id ORDER BY last_ts DESC`
    ).all(String(chatId));

    const titleStmt = this.db.prepare(
      `SELECT raw_meta FROM messages WHERE source='telegram' AND chat_id=? AND topic_id=? AND raw_meta LIKE '%"topic_title"%'
       ORDER BY timestamp ASC LIMIT 1`
    );
    const firstTextStmt = this.db.prepare(
      `SELECT content FROM messages WHERE source='telegram' AND chat_id=? AND topic_id=?
       AND content IS NOT NULL AND content != '' AND content != '[media]'
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
      for (const rr of titleStmt.all(String(chatId), String(r.topic_id))) {
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
      const finalName = name.length > 60 ? name.slice(0, 60) + '…' : name;

      const pkCol = this.#legacyTopicPkCol();
      this.db.prepare(
        `UPDATE topics SET name = ?, meta = ?, updated_at = COALESCE(updated_at, ?) WHERE ${pkCol} = ?`
      ).run(finalName, JSON.stringify({ source: 'telegram', chatId: String(chatId), topicId: String(r.topic_id) }), Number(r.last_ts || Date.now()), topicUUID);

      out.push({
        id: String(r.topic_id), chatId: String(chatId), topicUUID,
        name: finalName, lastTimestamp: r.last_ts, messageCount: r.msg_count, archived, deletedAt,
      });
    }
    return out;
  }

  getClaudeTopics({ limit = 100, encodedProject = null } = {}) {
    const pkCol = this.#legacyTopicPkCol();
    const hasLegacySrc = this.#topicsHasLegacyPk(); // legacy schema has source as a column
    const sourceFilter = hasLegacySrc
      ? `source = 'claude'`
      : `json_extract(meta, '$.source') = 'claude'`;
    const projectFilter = encodedProject
      ? `AND json_extract(meta, '$.encoded_project') = ?`
      : '';
    const params = encodedProject
      ? [encodedProject, Number(limit) || 100]
      : [Number(limit) || 100];
    const rows = this.db.prepare(
      `SELECT ${pkCol} AS topic_uuid, name, meta, created_at, updated_at
       FROM topics
       WHERE ${sourceFilter}
         ${projectFilter}
         AND archived = 0 AND deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT ?`
    ).all(...params);

    return rows.map(row => {
      let meta = null;
      try { meta = row.meta ? JSON.parse(row.meta) : null; } catch {}
      const sessionId = meta?.session_id || null;
      const msgCount = sessionId
        ? (this.db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE source='claude' AND topic_id=?`).get(sessionId)?.c || 0)
        : 0;
      const projectName = meta?.cwd
        ? meta.cwd.split('/').filter(Boolean).pop()
        : (meta?.encoded_project || '').split('-').filter(Boolean).pop() || null;
      return {
        topicUUID: String(row.topic_uuid),
        name: row.name || sessionId?.slice(0, 8) || 'Session',
        sessionId,
        hostname: meta?.hostname || null,
        encodedProject: meta?.encoded_project || null,
        projectName,
        cwd: meta?.cwd || null,
        gitBranch: meta?.git_branch || null,
        messageCount: Number(msgCount),
        updatedAt: row.updated_at ? Number(row.updated_at) : null,
        createdAt: row.created_at ? Number(row.created_at) : null,
      };
    });
  }

  /** Aggregate Claude sessions into project summaries, ordered by most recently active. */
  getClaudeProjects() {
    const sessions = this.getClaudeTopics({ limit: 1000 });
    const projectMap = new Map();
    for (const s of sessions) {
      const key = `${s.hostname}:${s.encodedProject}`;
      if (!projectMap.has(key)) {
        projectMap.set(key, {
          key,
          hostname: s.hostname,
          encodedProject: s.encodedProject,
          projectName: s.projectName,
          sessionCount: 0,
          updatedAt: 0,
        });
      }
      const p = projectMap.get(key);
      p.sessionCount++;
      if ((s.updatedAt || 0) > p.updatedAt) p.updatedAt = s.updatedAt;
    }
    return [...projectMap.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  searchTopics({ query, limit = 50, offset = 0, sort = {} }) {
    const normalizedQuery = String(query || '').trim();
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const normalizedOffset = Math.max(0, Number(offset) || 0);
    const sortField = String(sort?.field || 'updatedAt');
    const sortDirection = String(sort?.direction || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    if (!normalizedQuery) throw new Error('query required');

    const like = `%${normalizedQuery.replace(/[%_\\]/g, '\\$&')}%`;
    const pkCol = this.#legacyTopicPkCol();
    const hasSrcCol = this.#topicsHasLegacyPk();
    const rows = this.db.prepare(
      `SELECT ${pkCol} AS pk, ${hasSrcCol ? 'source, ' : ''}name, meta, created_at, updated_at, archived, deleted_at
       FROM topics WHERE archived = 0 AND deleted_at IS NULL AND name IS NOT NULL
       AND LOWER(name) LIKE LOWER(?) ESCAPE '\\'`
    ).all(like)
      .map(row => { let meta = null; try { meta = row.meta ? JSON.parse(row.meta) : null; } catch {} return { ...row, meta }; })
      .sort((a, b) => {
        const av = sortField === 'createdAt' ? Number(a.created_at || 0) : Number(a.updated_at || 0);
        const bv = sortField === 'createdAt' ? Number(b.created_at || 0) : Number(b.updated_at || 0);
        return sortDirection === 'ASC' ? av - bv : bv - av;
      });

    const paged = rows.slice(normalizedOffset, normalizedOffset + normalizedLimit);
    return {
      query: normalizedQuery, total: rows.length, limit: normalizedLimit, offset: normalizedOffset,
      results: paged.map(row => ({
        topicUUID: String(row.pk), source: String(row.source || row.meta?.source || ''), title: String(row.name || ''),
        createdAt: row.created_at ? Number(row.created_at) : null,
        updatedAt: row.updated_at ? Number(row.updated_at) : null,
        meta: row.meta || null,
      })),
    };
  }

  #touchLayerUpdatedAt({ source, chatId, topicId }) {
    if (!source || !chatId || !topicId) return;
    const hasLegacy = this.db.prepare(`PRAGMA table_info(layers)`).all().map(c => c.name).includes('layer_uuid');
    const maxRow = this.db.prepare(
      `SELECT MAX(timestamp) AS max_ts FROM messages WHERE source=? AND chat_id=? AND topic_id=?`
    ).get(String(source), String(chatId), String(topicId));
    const maxTs = Number(maxRow?.max_ts || 0);
    if (!maxTs) return;
    if (hasLegacy) {
      const channel = topicId;
      this.db.prepare(`UPDATE layers SET updated_at=? WHERE source=? AND channel=?`)
        .run(maxTs, String(source), String(channel));
    } else {
      this.db.prepare(
        `UPDATE layers SET updated_at=? WHERE first_message_id IN (SELECT id FROM messages WHERE source=? AND chat_id=? AND topic_id=?)`
      ).run(maxTs, String(source), String(chatId), String(topicId));
    }
  }

  #touchTopicUpdatedAt({ source, chatId, topicId, timestamp }) {
    const ts = Number(timestamp || 0);
    if (!Number.isFinite(ts) || ts <= 0) return;
    if (String(source) === 'telegram' && chatId && topicId) {
      const topicUUID = this.getOrCreateTopicUUID(source, chatId, topicId);
      const maxRow = this.db.prepare(
        `SELECT MAX(timestamp) AS max_ts FROM messages WHERE source=? AND chat_id=? AND topic_id=?`
      ).get(source, chatId, topicId);
      const pkCol = this.#legacyTopicPkCol();
      this.db.prepare(`UPDATE topics SET updated_at=? WHERE ${pkCol}=?`).run(Number(maxRow?.max_ts || ts), topicUUID);
    }
  }

  // --- Layers ---

  upsertLayers(source, channel, layers = []) {
    const now = Date.now();
    const hasLegacy = this.db.prepare(`PRAGMA table_info(layers)`).all().map(c => c.name).includes('layer_uuid');
    const pkCol = hasLegacy ? 'layer_uuid' : 'id';
    const parentCol = hasLegacy ? 'parent_layer_uuid' : 'parent_layer_id';

    const stmt = this.db.prepare(`
      INSERT INTO layers (${pkCol}, ${hasLegacy ? 'source, channel, ' : ''}first_message_id, ${parentCol}, done, created_at, updated_at)
      VALUES (?, ${hasLegacy ? '?, ?, ' : ''}?, ?, COALESCE((SELECT done FROM layers WHERE ${pkCol} = ?), 0), ?, ?)
      ON CONFLICT(${pkCol}) DO UPDATE SET
        first_message_id = COALESCE(excluded.first_message_id, layers.first_message_id),
        ${parentCol} = excluded.${parentCol},
        updated_at = excluded.updated_at
        ${hasLegacy ? ', source = excluded.source, channel = excluded.channel' : ''}
    `);

    const tx = this.db.transaction((items) => {
      for (const l of items) {
        if (!l?.id) continue;
        if (hasLegacy) {
          stmt.run(String(l.id), String(source), String(channel), l.firstMessageId ? String(l.firstMessageId) : null, l.parentLayerUuid ? String(l.parentLayerUuid) : null, String(l.id), now, now);
        } else {
          stmt.run(String(l.id), l.firstMessageId ? String(l.firstMessageId) : null, l.parentLayerUuid ? String(l.parentLayerUuid) : null, String(l.id), now, now);
        }
      }
    });
    tx(layers);
  }

  getLayerStatuses(source, channel) {
    const hasLegacy = this.db.prepare(`PRAGMA table_info(layers)`).all().map(c => c.name).includes('layer_uuid');
    if (hasLegacy) {
      return this.db.prepare(`SELECT layer_uuid, title, done, updated_at FROM layers WHERE source=? AND channel=?`).all(String(source), String(channel));
    }
    return this.db.prepare(`SELECT id AS layer_uuid, title, done, updated_at FROM layers`).all();
  }

  setLayerTitle(source, channel, layerUuid, title) {
    const now = Date.now();
    const normalizedTitle = String(title || '').trim();
    const hasLegacy = this.db.prepare(`PRAGMA table_info(layers)`).all().map(c => c.name).includes('layer_uuid');
    if (hasLegacy) {
      this.db.prepare(
        `INSERT INTO layers (layer_uuid, source, channel, title, done, created_at, updated_at)
         VALUES (?, ?, ?, ?, COALESCE((SELECT done FROM layers WHERE layer_uuid=?), 0), ?, ?)
         ON CONFLICT(layer_uuid) DO UPDATE SET title=excluded.title, source=excluded.source, channel=excluded.channel, updated_at=excluded.updated_at`
      ).run(String(layerUuid), String(source), String(channel), normalizedTitle || null, String(layerUuid), now, now);
    } else {
      this.db.prepare(
        `INSERT INTO layers (id, title, done, created_at, updated_at)
         VALUES (?, ?, COALESCE((SELECT done FROM layers WHERE id=?), 0), ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at`
      ).run(String(layerUuid), normalizedTitle || null, String(layerUuid), now, now);
    }
    return { ok: true, layerUuid: String(layerUuid), title: normalizedTitle || null, updatedAt: now };
  }

  setLayerDone(source, channel, layerUuid, done) {
    const now = Date.now();
    const hasLegacy = this.db.prepare(`PRAGMA table_info(layers)`).all().map(c => c.name).includes('layer_uuid');
    if (hasLegacy) {
      this.db.prepare(
        `INSERT INTO layers (layer_uuid, source, channel, done, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(layer_uuid) DO UPDATE SET done=excluded.done, source=excluded.source, channel=excluded.channel, updated_at=excluded.updated_at`
      ).run(String(layerUuid), String(source), String(channel), done ? 1 : 0, now, now);
    } else {
      this.db.prepare(
        `INSERT INTO layers (id, done, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET done=excluded.done, updated_at=excluded.updated_at`
      ).run(String(layerUuid), done ? 1 : 0, now, now);
    }
    return { ok: true, layerUuid: String(layerUuid), done: !!done, updatedAt: now };
  }

  // --- Search ---

  searchMessages({ source, query, scope = {}, limit = 50, offset = 0 }) {
    const normalizedSource = String(source || '').trim();
    const normalizedQuery = String(query || '').trim();
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const normalizedOffset = Math.max(0, Number(offset) || 0);
    if (!normalizedSource) throw new Error('source required');
    if (!normalizedQuery) throw new Error('query required');

    const channel = scope?.channel != null && scope.channel !== '' ? String(scope.channel) : null;
    const topicId = scope?.topicId != null && scope.topicId !== '' ? String(scope.topicId) : null;
    const chatId = scope?.chatId != null && scope.chatId !== '' ? String(scope.chatId) : null;

    const where = ['source = ?', "content IS NOT NULL", "content != ''"];
    const params = [normalizedSource];

    if (normalizedSource === 'telegram') {
      if (!chatId) throw new Error('scope.chatId required');
      if (!topicId) throw new Error('scope.topicId required');
      where.push('chat_id = ?'); params.push(chatId);
      where.push('topic_id = ?'); params.push(topicId);
    } else {
      if (!channel) throw new Error('scope.channel required');
      where.push('(channel = ? OR topic_id = ? OR chat_id = ?)');
      params.push(channel, channel, channel);
    }

    const like = `%${normalizedQuery.replace(/[%_\\]/g, '\\$&')}%`;
    where.push("LOWER(content) LIKE LOWER(?) ESCAPE '\\'");
    params.push(like);

    const countRow = this.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${where.join(' AND ')}`).get(...params);
    const rows = this.db.prepare(
      `SELECT id, chat_id, topic_id, content, timestamp FROM messages
       WHERE ${where.join(' AND ')} ORDER BY timestamp ASC, id ASC LIMIT ? OFFSET ?`
    ).all(...params, normalizedLimit, normalizedOffset);

    return {
      source: normalizedSource, query: normalizedQuery,
      total: Number(countRow?.count || 0), limit: normalizedLimit, offset: normalizedOffset,
      results: rows.map(row => ({
        locator: { chatId: row.chat_id, topicId: row.topic_id, messageId: this.#getSourceLocalMessageId(row.id) },
        snippet: this.#buildSearchSnippet(row.content, normalizedQuery),
        timestamp: row.timestamp,
      })),
    };
  }

  #getSourceLocalMessageId(id) {
    const s = String(id || '');
    const idx = s.lastIndexOf(':');
    return idx >= 0 ? s.slice(idx + 1) : s;
  }

  #buildSearchSnippet(content, query, radius = 40) {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const haystack = text.toLowerCase();
    const needle = String(query || '').toLowerCase();
    const matchIndex = haystack.indexOf(needle);
    if (matchIndex < 0) {
      return text.length <= (radius * 2) ? text : `${text.slice(0, radius * 2 - 1)}…`;
    }
    const start = Math.max(0, matchIndex - radius);
    const end = Math.min(text.length, matchIndex + needle.length + radius);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    return `${prefix}${text.slice(start, end)}${suffix}`;
  }

  close() {
    this.db.close();
  }
}

module.exports = { Database, uuidv5, KP_NAMESPACE };
