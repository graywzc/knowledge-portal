const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { Database } = require('../db/Database');
const { createApp } = require('./index');

describe('POST /api/telegram/send', () => {
  let dir;
  let dbPath;
  let mockSender;
  let app;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-telegram-send-'));
    dbPath = path.join(dir, 'test.db');
    const db = new Database(dbPath);
    db.close();

    mockSender = {
      sendText: jest.fn().mockResolvedValue({
        ok: true,
        telegramMessageId: 2118,
        chatId: '-1003826585913',
        replyToId: null,
      }),
    };

    app = createApp({ dbPath, telegramSender: mockSender });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends message with valid payload', async () => {
    const res = await request(app)
      .post('/api/telegram/send')
      .send({ chatId: '-1003826585913', text: 'hello' })
      .expect(200);

    expect(mockSender.sendText).toHaveBeenCalledWith({
      chatId: '-1003826585913',
      text: 'hello',
      replyToId: undefined,
    });
    expect(res.body).toEqual({
      ok: true,
      telegramMessageId: 2118,
      chatId: '-1003826585913',
      replyToId: null,
    });
  });

  it('uses TG_CHAT_ID fallback when chatId is omitted', async () => {
    process.env.TG_CHAT_ID = '-1003826585913';
    await request(app)
      .post('/api/telegram/send')
      .send({ text: 'x' })
      .expect(200);

    expect(mockSender.sendText).toHaveBeenCalledWith({
      chatId: '-1003826585913',
      text: 'x',
      replyToId: undefined,
    });
    delete process.env.TG_CHAT_ID;
  });

  it('validates required fields', async () => {
    await request(app)
      .post('/api/telegram/send')
      .send({ chatId: '-1003826585913', text: '   ' })
      .expect(400)
      .expect({ error: 'text required' });
  });

  it('maps sender validation errors to 400', async () => {
    mockSender.sendText.mockRejectedValueOnce(new Error('replyToId must be a numeric Telegram message id'));

    const res = await request(app)
      .post('/api/telegram/send')
      .send({ chatId: '-1003826585913', text: 'x', replyToId: 'abc' })
      .expect(400);

    expect(res.body).toEqual({ error: 'replyToId must be a numeric Telegram message id' });
  });

  it('returns 500 for unexpected sender failures', async () => {
    mockSender.sendText.mockRejectedValueOnce(new Error('rpc timeout'));

    const res = await request(app)
      .post('/api/telegram/send')
      .send({ chatId: '-1003826585913', text: 'x' })
      .expect(500);

    expect(res.body).toEqual({ error: 'telegram send failed', detail: 'rpc timeout' });
  });
});
