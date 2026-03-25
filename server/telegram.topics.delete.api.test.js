const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { Database } = require('../db/Database');
const { createApp } = require('./index');

describe('POST /api/topics/:topicUUID/delete', () => {
  let dir;
  let dbPath;
  let mockSender;
  let app;
  let topicUUID;

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
    topicUUID = db.getOrCreateTopicUUID('telegram', '-100', '55');
    db.close();

    mockSender = {
      sendText: jest.fn(),
      createTopic: jest.fn(),
      deleteTopic: jest.fn().mockResolvedValue({ ok: true, chatId: '-100', topicId: 55 }),
    };

    app = createApp({ dbPath, telegramSender: mockSender });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes topic on telegram and marks deleted_at while preserving history', async () => {
    await request(app)
      .post(`/api/topics/${encodeURIComponent(topicUUID)}/delete`)
      .send({ chatId: '-100', topicId: 55 })
      .expect(200);

    expect(mockSender.deleteTopic).toHaveBeenCalledWith({ chatId: '-100', topicId: 55 });

    const db = new Database(dbPath);
    const topic = db.getTopicByUUID(topicUUID);
    const msgs = db.getMessages('telegram', '55');
    db.close();

    expect(topic.deleted_at).not.toBeNull();
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('returns 404 for unknown topic uuid', async () => {
    await request(app)
      .post('/api/topics/00000000-0000-5000-8000-000000000999/delete')
      .send({})
      .expect(404)
      .expect({ error: 'topic not found' });
  });
});
