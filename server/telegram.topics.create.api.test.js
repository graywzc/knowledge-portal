const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { Database } = require('../db/Database');
const { createApp } = require('./index');

describe('POST /api/telegram/topics/create', () => {
  let dir;
  let dbPath;
  let mockSender;
  let app;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-telegram-topic-create-'));
    dbPath = path.join(dir, 'test.db');
    const db = new Database(dbPath);
    db.close();

    mockSender = {
      sendText: jest.fn(),
      createTopic: jest.fn().mockResolvedValue({
        ok: true,
        chatId: '-1003826585913',
        title: 'Roadmap',
        topicId: 3001,
      }),
    };

    app = createApp({ dbPath, telegramSender: mockSender });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates topic with valid payload', async () => {
    const res = await request(app)
      .post('/api/telegram/topics/create')
      .send({ chatId: '-1003826585913', title: 'Roadmap' })
      .expect(200);

    expect(mockSender.createTopic).toHaveBeenCalledWith({
      chatId: '-1003826585913',
      title: 'Roadmap',
    });
    expect(res.body.ok).toBe(true);
    expect(res.body.topicId).toBe(3001);
  });

  it('validates title', async () => {
    await request(app)
      .post('/api/telegram/topics/create')
      .send({ chatId: '-1003826585913', title: '   ' })
      .expect(400)
      .expect({ error: 'title required' });
  });
});
