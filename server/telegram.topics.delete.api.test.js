const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { Database } = require('../db/Database');
const { createApp } = require('./index');

describe('POST /api/telegram/topics/delete', () => {
  let dir;
  let dbPath;
  let mockSender;
  let app;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-telegram-topic-delete-'));
    dbPath = path.join(dir, 'test.db');
    const db = new Database(dbPath);
    db.insertMessage({
      id: 'tg:-100:55',
      source: 'telegram',
      channel: '55',
      chatId: '-100',
      topicId: '55',
      senderId: 'u1',
      content: 'topic starter',
      replyToId: null,
      timestamp: 1,
      rawMeta: '{}',
    });
    db.close();

    mockSender = {
      sendText: jest.fn(),
      deleteTopic: jest.fn().mockResolvedValue({ ok: true, chatId: '-100', topicId: 55 }),
    };

    app = createApp({ dbPath, telegramSender: mockSender });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes topic and removes topic messages from DB', async () => {
    await request(app)
      .post('/api/telegram/topics/delete')
      .send({ chatId: '-100', topicId: 55 })
      .expect(200)
      .expect({ ok: true, chatId: '-100', topicId: 55 });

    expect(mockSender.deleteTopic).toHaveBeenCalledWith({ chatId: '-100', topicId: 55 });

    const db = new Database(dbPath);
    const topics = db.getTelegramTopics('-100');
    db.close();
    expect(topics.find((t) => String(t.id) === '55')).toBeUndefined();
  });

  it('validates topicId', async () => {
    await request(app)
      .post('/api/telegram/topics/delete')
      .send({ chatId: '-100', topicId: '' })
      .expect(400)
      .expect({ error: 'topicId required' });
  });
});
