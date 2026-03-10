const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { createApp } = require('./index');

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

describe('API contract tests', () => {
  let dir;
  let dbPath;
  let app;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-api-contract-'));
    dbPath = path.join(dir, 'test.db');
    app = createApp({ dbPath });

    await request(app).post('/api/ingest').send([
      {
        id: 'tg:-100:1',
        source: 'telegram',
        channel: '55',
        chatId: '-100',
        topicId: '55',
        senderId: 'u1',
        content: 'hello',
        timestamp: 1700000000000,
      },
      {
        id: 'tg:-100:2',
        source: 'telegram',
        channel: '55',
        chatId: '-100',
        topicId: '55',
        senderId: 'u2',
        replyToId: 'tg:-100:1',
        content: 'world',
        timestamp: 1700000001000,
      },
    ]);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GET /api/sources returns array<string>', async () => {
    const res = await request(app).get('/api/sources').expect(200);
    expect(isStringArray(res.body)).toBe(true);
    expect(res.body).toContain('telegram');
  });

  it('GET /api/sources/:source/channels returns array<string>', async () => {
    const res = await request(app).get('/api/sources/telegram/channels').expect(200);
    expect(isStringArray(res.body)).toBe(true);
    expect(res.body).toContain('55');
  });

  it('GET /api/sources/:source/channels/:channel/view returns stable view schema', async () => {
    const res = await request(app).get('/api/sources/telegram/channels/55/view').expect(200);

    expect(typeof res.body).toBe('object');
    expect(res.body).toHaveProperty('tree');
    expect(res.body).toHaveProperty('currentLayerId');
    expect(res.body).toHaveProperty('state');

    expect(typeof res.body.currentLayerId).toBe('string');
    expect(typeof res.body.state).toBe('object');
    expect(typeof res.body.state.layers).toBe('object');

    const layerA = res.body.state.layers.A;
    expect(layerA).toBeTruthy();
    expect(Array.isArray(layerA.messages)).toBe(true);
    expect(Array.isArray(layerA.children)).toBe(true);
  });

  it('GET /api/sources/:source/channels/:channel/layers/:layerId returns 404 error schema when missing', async () => {
    const res = await request(app)
      .get('/api/sources/telegram/channels/55/layers/NOPE')
      .expect(404);

    expect(res.body).toEqual({ error: 'Layer not found' });
  });

  it('GET /api/telegram/topics returns 400 error schema when chat is missing', async () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-api-contract-empty-'));
    const freshApp = createApp({ dbPath: path.join(freshDir, 'empty.db') });

    const res = await request(freshApp).get('/api/telegram/topics').expect(400);
    expect(res.body).toEqual({ error: 'chatId required' });

    fs.rmSync(freshDir, { recursive: true, force: true });
  });

  it('POST /api/ingest returns {ingested:number} and ignores invalid payload entries', async () => {
    const res = await request(app)
      .post('/api/ingest')
      .send([
        {
          id: 'tg:-100:3',
          source: 'telegram',
          channel: '55',
          senderId: 'u1',
          content: 'ok',
          timestamp: 1700000002000,
        },
        {
          // invalid: missing required fields
          id: 'bad',
        },
      ])
      .expect(200);

    expect(typeof res.body.ingested).toBe('number');
    expect(res.body.ingested).toBe(1);
  });

  it('POST /api/ingest/telegram returns {ingested:number}', async () => {
    const res = await request(app)
      .post('/api/ingest/telegram')
      .send({
        messages: [
          {
            message_id: 99,
            date: 1700000010,
            text: 'telegram payload',
            chat: { id: -100 },
            from: { id: 123, first_name: 'A' },
            message_thread_id: 55,
          },
        ],
      })
      .expect(200);

    expect(typeof res.body.ingested).toBe('number');
    expect(res.body.ingested).toBe(1);
  });
});
