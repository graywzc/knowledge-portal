/**
 * TelegramAdapter — ingests Telegram messages into the database.
 *
 * This adapter converts Telegram's message format to the source-agnostic
 * database schema. It knows nothing about the portal UI or tree logic.
 *
 * Usage:
 *   const adapter = new TelegramAdapter(database);
 *   adapter.ingest(telegramMessage);       // single message
 *   adapter.ingestBatch(telegramMessages);  // bulk import
 */

class TelegramAdapter {
  /**
   * @param {import('../db/Database').Database} db
   * @param {object} opts
   * @param {string} opts.selfUserId - the bot's own user id (to determine sender_role)
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.selfUserId = opts.selfUserId || null;
  }

  /**
   * Convert a Telegram message object to our schema and insert.
   * Accepts the standard Telegram Bot API message format.
   *
   * @param {object} tgMsg - Telegram message object
   * @param {string} [channelOverride] - override channel (e.g., topic id)
   */
  ingest(tgMsg, channelOverride) {
    const msg = this._transform(tgMsg, channelOverride);
    if (msg) this.db.insertMessage(msg);
    return msg;
  }

  /**
   * Bulk ingest.
   */
  ingestBatch(tgMessages, channelOverride) {
    const msgs = tgMessages
      .map(m => this._transform(m, channelOverride))
      .filter(Boolean);
    if (msgs.length) this.db.insertMessages(msgs);
    return msgs;
  }

  _transform(tgMsg, channelOverride) {
    if (!tgMsg.message_id) return null;

    const chatId = String(tgMsg.chat?.id || '');
    const topicId = tgMsg.message_thread_id ? String(tgMsg.message_thread_id) : null;
    const channel = channelOverride || topicId || chatId;

    const senderId = String(tgMsg.from?.id || '');
    const senderName = [tgMsg.from?.first_name, tgMsg.from?.last_name].filter(Boolean).join(' ') || null;
    const senderRole = (this.selfUserId && senderId === this.selfUserId) ? 'self' : 'user';

    const replyToId = tgMsg.reply_to_message?.message_id
      ? `tg:${chatId}:${tgMsg.reply_to_message.message_id}`
      : null;

    const content = tgMsg.text || tgMsg.caption || '[media]';
    const contentType = tgMsg.text ? 'text' : (tgMsg.photo ? 'image' : 'other');

    return {
      id: `tg:${chatId}:${tgMsg.message_id}`,
      source: 'telegram',
      channel,
      senderId,
      senderName,
      senderRole,
      replyToId,
      content,
      contentType,
      timestamp: (tgMsg.date || 0) * 1000,
      rawMeta: {
        chat_id: chatId,
        message_id: tgMsg.message_id,
        message_thread_id: tgMsg.message_thread_id || null,
      },
    };
  }
}

module.exports = { TelegramAdapter };
