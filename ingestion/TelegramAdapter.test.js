const assert = require('node:assert');
const { TelegramAdapter } = require('./TelegramAdapter');

function createFakeDb() {
  const rows = [];
  return {
    rows,
    insertMessage: (m) => rows.push(m),
    insertMessages: (ms) => rows.push(...ms),
  };
}

describe('TelegramAdapter', () => {
  it('transforms a telegram text message into normalized schema', () => {
    const db = createFakeDb();
    const adapter = new TelegramAdapter(db, { selfUserId: '777' });

    const msg = {
      message_id: 100,
      date: 1700000000,
      text: 'hello',
      chat: { id: -100123 },
      from: { id: 777, first_name: 'Bot' },
      message_thread_id: 55,
    };

    const out = adapter.ingest(msg);

    assert.strictEqual(out.id, 'tg:-100123:100');
    assert.strictEqual(out.chatId, '-100123');
    assert.strictEqual(out.topicId, '55');
    assert.strictEqual(out.channel, '55');
    assert.strictEqual(out.senderRole, 'self');
    assert.strictEqual(out.contentType, 'text');
    assert.strictEqual(out.timestamp, 1700000000 * 1000);
    assert.strictEqual(db.rows.length, 1);
  });

  it('sets replyToId correctly and ingests reply_to_message parent first', () => {
    const db = createFakeDb();
    const adapter = new TelegramAdapter(db, { selfUserId: '777' });

    const msg = {
      message_id: 11,
      date: 1700000010,
      text: 'reply',
      chat: { id: -100123 },
      from: { id: 1, first_name: 'User' },
      message_thread_id: 55,
      reply_to_message: {
        message_id: 10,
        date: 1700000005,
        text: 'parent',
        chat: { id: -100123 },
        from: { id: 2, first_name: 'Other' },
        message_thread_id: 55,
      },
    };

    const out = adapter.ingest(msg);

    assert.strictEqual(out.replyToId, 'tg:-100123:10');
    assert.strictEqual(db.rows.length, 2);
    assert.strictEqual(db.rows[0].id, 'tg:-100123:10');
    assert.strictEqual(db.rows[1].id, 'tg:-100123:11');
  });

  it('ingestBatch transforms valid records and drops invalid rows', () => {
    const db = createFakeDb();
    const adapter = new TelegramAdapter(db);

    const out = adapter.ingestBatch([
      {
        message_id: 1,
        date: 1700000000,
        text: 'ok',
        chat: { id: -100 },
        from: { id: 1 },
      },
      {
        // invalid - missing message_id
        date: 1700000001,
        text: 'bad',
        chat: { id: -100 },
        from: { id: 2 },
      },
      {
        message_id: 2,
        date: 1700000002,
        photo: [{ file_id: 'abc' }],
        caption: 'pic',
        chat: { id: -100 },
        from: { id: 3 },
      },
    ]);

    assert.strictEqual(out.length, 2);
    assert.strictEqual(db.rows.length, 2);
    assert.strictEqual(out[1].contentType, 'image');
    assert.strictEqual(out[1].content, 'pic');
  });
});
