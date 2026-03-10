const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');
const { Database } = require('./Database');

const dbsToCleanup = [];

function createTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-portal-db-'));
  const dbPath = path.join(dir, 'test.db');
  const db = new Database(dbPath);
  dbsToCleanup.push({ db, dir });
  return db;
}

afterEach(() => {
  while (dbsToCleanup.length) {
    const { db, dir } = dbsToCleanup.pop();
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Database', () => {
  it('inserts and reads messages within topic/chat scope', () => {
    const db = createTestDb();

    db.insertMessage({
      id: 'tg:-100:1',
      source: 'telegram',
      chatId: '-100',
      topicId: '55',
      senderId: 'u1',
      content: 'hello',
      timestamp: 1000,
    });

    db.insertMessage({
      id: 'tg:-100:2',
      source: 'telegram',
      chatId: '-100',
      topicId: '55',
      senderId: 'u2',
      content: 'world',
      timestamp: 2000,
    });

    const byTopic = db.getMessages('telegram', '55');
    assert.strictEqual(byTopic.length, 2);
    assert.deepEqual(byTopic.map(m => m.id), ['tg:-100:1', 'tg:-100:2']);

    const byChat = db.getMessages('telegram', '-100');
    assert.strictEqual(byChat.length, 2);
  });

  it('upserts duplicate ids and preserves existing chat/topic ids', () => {
    const db = createTestDb();

    db.insertMessage({
      id: 'tg:-100:42',
      source: 'telegram',
      chatId: '-100',
      topicId: '55',
      senderId: 'u1',
      content: 'first',
      timestamp: 1000,
    });

    db.insertMessage({
      id: 'tg:-100:42',
      source: 'telegram',
      channel: 'override-channel',
      senderId: 'u1',
      content: 'updated',
      timestamp: 1500,
    });

    const row = db.getMessage('tg:-100:42');
    assert.strictEqual(row.content, 'updated');
    assert.strictEqual(row.chat_id, '-100');
    assert.strictEqual(row.topic_id, '55');
  });

  it('returns channels and primary telegram chat id', () => {
    const db = createTestDb();

    db.insertMessages([
      {
        id: 'tg:-100a:1', source: 'telegram', chatId: '-100a', topicId: '10', senderId: 'u1', content: 'a', timestamp: 1,
      },
      {
        id: 'tg:-100a:2', source: 'telegram', chatId: '-100a', topicId: '10', senderId: 'u1', content: 'b', timestamp: 2,
      },
      {
        id: 'tg:-100b:3', source: 'telegram', chatId: '-100b', topicId: '20', senderId: 'u2', content: 'c', timestamp: 3,
      },
    ]);

    const channels = db.getChannels('telegram');
    assert.deepEqual(channels.sort(), ['10', '20']);
    assert.strictEqual(db.getPrimaryTelegramChatId(), '-100a');
  });

  it('derives telegram topic names from metadata then first text fallback', () => {
    const db = createTestDb();

    db.insertMessages([
      {
        id: 'tg:-100:1',
        source: 'telegram',
        chatId: '-100',
        topicId: '55',
        senderId: 'u1',
        content: 'seed text',
        timestamp: 1000,
        rawMeta: { topic_title: 'Roadmap Topic' },
      },
      {
        id: 'tg:-100:2',
        source: 'telegram',
        chatId: '-100',
        topicId: '56',
        senderId: 'u2',
        content: 'Fallback topic title from first text',
        timestamp: 1100,
      },
      {
        id: 'tg:-100:3',
        source: 'telegram',
        chatId: '-100',
        topicId: '56',
        senderId: 'u2',
        content: '[media]',
        timestamp: 1200,
      },
    ]);

    const topics = db.getTelegramTopics('-100');
    const t55 = topics.find(t => t.id === '55');
    const t56 = topics.find(t => t.id === '56');

    assert.strictEqual(t55.name, 'Roadmap Topic');
    assert.strictEqual(t56.name, 'Fallback topic title from first text');
  });

  it('normalizes legacy telegram scope rows, lists sources, and closes db', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-portal-db-legacy-'));
    const dbPath = path.join(dir, 'legacy.db');

    const raw = new BetterSqlite3(dbPath);
    raw.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8'));
    raw.prepare(`
      INSERT INTO messages (id, source, channel, sender_id, content, timestamp, raw_meta)
      VALUES (?, 'telegram', ?, 'u1', 'legacy', 1, ?)
    `).run('tg:legacy:1', 'legacy-scope', JSON.stringify({ chat_id: '-100x', message_thread_id: 77 }));
    raw.close();

    const db = new Database(dbPath);
    const row = db.getMessage('tg:legacy:1');
    assert.strictEqual(row.chat_id, '-100x');
    assert.strictEqual(row.topic_id, '77');
    assert.strictEqual(row.channel, '77');

    const sources = db.getSources();
    assert.ok(sources.includes('telegram'));

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
