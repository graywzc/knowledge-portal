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
  }

  /**
   * Insert a message. Idempotent (ignores duplicates by id).
   */
  insertMessage(msg) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (id, source, channel, sender_id, sender_name, sender_role, reply_to_id, content, content_type, timestamp, raw_meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      msg.id,
      msg.source,
      msg.channel,
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
    return this.db.prepare(
      'SELECT * FROM messages WHERE source = ? AND channel = ? ORDER BY timestamp ASC'
    ).all(source, channel);
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
      'SELECT DISTINCT channel FROM messages WHERE source = ? ORDER BY channel'
    ).all(source).map(r => r.channel);
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
