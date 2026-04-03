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
      split: false,
      chunkCount: 1,
      chunks: [{
        ok: true,
        telegramMessageId: 2118,
        chatId: '-1003826585913',
        replyToId: null,
      }],
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

  it('auto-splits overlong telegram text into multiple sends', async () => {
    mockSender.sendText
      .mockResolvedValueOnce({ ok: true, telegramMessageId: 3001, chatId: '-1003826585913', replyToId: null })
      .mockResolvedValueOnce({ ok: true, telegramMessageId: 3002, chatId: '-1003826585913', replyToId: 3001 });

    const longText = `${'a'.repeat(4090)} ${'b'.repeat(20)}`;
    const res = await request(app)
      .post('/api/telegram/send')
      .send({ chatId: '-1003826585913', text: longText })
      .expect(200);

    expect(mockSender.sendText).toHaveBeenCalledTimes(2);
    expect(mockSender.sendText.mock.calls[0][0]).toEqual({
      chatId: '-1003826585913',
      text: expect.any(String),
      replyToId: undefined,
    });
    expect(mockSender.sendText.mock.calls[0][0].text.length).toBeLessThanOrEqual(4096);
    expect(mockSender.sendText.mock.calls[1][0]).toEqual({
      chatId: '-1003826585913',
      text: expect.any(String),
      replyToId: 3001,
    });
    expect(mockSender.sendText.mock.calls[1][0].text.length).toBeLessThanOrEqual(4096);
    expect(res.body.split).toBe(true);
    expect(res.body.chunkCount).toBe(2);
    expect(Array.isArray(res.body.chunks)).toBe(true);
    expect(res.body.chunks).toHaveLength(2);
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

describe('POST /api/telegram/send-images', () => {
  // 1×1 transparent PNG
  const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVIP/2Q==';

  let dir;
  let dbPath;
  let mockSender;
  let app;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-send-images-'));
    dbPath = path.join(dir, 'test.db');
    const db = new Database(dbPath);
    db.close();

    mockSender = {
      sendImages: jest.fn().mockResolvedValue({
        ok: true,
        chatId: '-1003826585913',
        results: [
          { ok: true, telegramMessageId: 5001 },
          { ok: true, telegramMessageId: 5002 },
        ],
      }),
    };

    app = createApp({ dbPath, telegramSender: mockSender });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends multiple images and puts caption only on the first', async () => {
    const res = await request(app)
      .post('/api/telegram/send-images')
      .send({ chatId: '-1003826585913', images: [PNG_DATA_URL, JPEG_DATA_URL], caption: 'look at these', replyToId: 42 })
      .expect(200);

    expect(mockSender.sendImages).toHaveBeenCalledWith({
      chatId: '-1003826585913',
      images: [
        { buffer: expect.any(Buffer), mimeType: 'image/png', caption: 'look at these' },
        { buffer: expect.any(Buffer), mimeType: 'image/jpeg', caption: '' },
      ],
      replyToId: 42,
    });
    expect(res.body).toEqual({
      ok: true,
      chatId: '-1003826585913',
      results: [
        { ok: true, telegramMessageId: 5001 },
        { ok: true, telegramMessageId: 5002 },
      ],
    });
  });

  it('sends a single image in the array', async () => {
    mockSender.sendImages.mockResolvedValueOnce({
      ok: true,
      chatId: '-1003826585913',
      results: [{ ok: true, telegramMessageId: 5001 }],
    });

    await request(app)
      .post('/api/telegram/send-images')
      .send({ chatId: '-1003826585913', images: [PNG_DATA_URL], caption: 'one image' })
      .expect(200);

    expect(mockSender.sendImages).toHaveBeenCalledWith({
      chatId: '-1003826585913',
      images: [{ buffer: expect.any(Buffer), mimeType: 'image/png', caption: 'one image' }],
      replyToId: undefined,
    });
  });

  it('uses TG_CHAT_ID fallback when chatId is omitted', async () => {
    process.env.TG_CHAT_ID = '-1003826585913';
    await request(app)
      .post('/api/telegram/send-images')
      .send({ images: [PNG_DATA_URL] })
      .expect(200);

    expect(mockSender.sendImages).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '-1003826585913' })
    );
    delete process.env.TG_CHAT_ID;
  });

  it('returns 400 when images array is missing', async () => {
    await request(app)
      .post('/api/telegram/send-images')
      .send({ chatId: '-1003826585913' })
      .expect(400)
      .expect({ error: 'images array required' });
  });

  it('returns 400 when images array is empty', async () => {
    await request(app)
      .post('/api/telegram/send-images')
      .send({ chatId: '-1003826585913', images: [] })
      .expect(400)
      .expect({ error: 'images array required' });
  });

  it('returns 400 when a dataUrl is invalid', async () => {
    const res = await request(app)
      .post('/api/telegram/send-images')
      .send({ chatId: '-1003826585913', images: [PNG_DATA_URL, 'not-a-data-url'] })
      .expect(400);

    expect(res.body).toEqual({ error: 'invalid dataUrl at index 1' });
  });

  it('maps sender validation errors to 400', async () => {
    mockSender.sendImages.mockRejectedValueOnce(new Error('replyToId must be a numeric Telegram message id'));

    const res = await request(app)
      .post('/api/telegram/send-images')
      .send({ chatId: '-1003826585913', images: [PNG_DATA_URL], replyToId: 'bad' })
      .expect(400);

    expect(res.body).toEqual({ error: 'replyToId must be a numeric Telegram message id' });
  });

  it('returns 500 for unexpected sender failures', async () => {
    mockSender.sendImages.mockRejectedValueOnce(new Error('network error'));

    const res = await request(app)
      .post('/api/telegram/send-images')
      .send({ chatId: '-1003826585913', images: [PNG_DATA_URL] })
      .expect(500);

    expect(res.body).toEqual({ error: 'telegram images send failed', detail: 'network error' });
  });
});
