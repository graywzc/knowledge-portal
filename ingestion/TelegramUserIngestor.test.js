const fs = require('fs');

const mockDbPrepareGet = jest.fn();
const mockDbPrepareRun = jest.fn();
const mockInsertMessage = jest.fn();

jest.mock('../db/Database', () => ({
  Database: jest.fn().mockImplementation(() => ({
    db: {
      exec: jest.fn(),
      prepare: jest.fn((sql) => {
        if (sql.includes('SELECT value FROM poller_state')) return { get: mockDbPrepareGet };
        return { run: mockDbPrepareRun };
      }),
    },
    insertMessage: mockInsertMessage,
  })),
}));

const mockStart = jest.fn();
const mockGetEntity = jest.fn();
const mockDownloadMedia = jest.fn();
let mockIterMessagesImpl = async function* () {};

jest.mock('telegram', () => ({
  TelegramClient: jest.fn().mockImplementation(() => ({
    start: mockStart,
    getEntity: mockGetEntity,
    iterMessages: (...args) => mockIterMessagesImpl(...args),
    downloadMedia: mockDownloadMedia,
    session: { save: () => 'saved-session' },
  })),
}));

jest.mock('telegram/sessions', () => ({
  StringSession: jest.fn().mockImplementation((s) => ({ session: s })),
}));

jest.mock('input', () => ({ text: jest.fn().mockResolvedValue('x') }));

const { TelegramUserIngestor } = require('./TelegramUserIngestor');

describe('TelegramUserIngestor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDbPrepareGet.mockReturnValue(null);
    mockIterMessagesImpl = async function* () {};
    mockDownloadMedia.mockResolvedValue(undefined);
  });

  it('start logs in and saves session', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    const ing = new TelegramUserIngestor({
      apiId: '1', apiHash: 'h', phone: '+1', dbPath: '/tmp/x.db', chatId: '-100',
    });

    await ing.start();
    expect(mockStart).toHaveBeenCalled();
    expect(mkdirSpy).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();
  });

  it('state helpers and topic filter work', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('session');

    const ing = new TelegramUserIngestor({
      apiId: '1', apiHash: 'h', phone: '+1', dbPath: '/tmp/x.db', chatId: '-100', topicId: '55',
    });

    expect(ing._stateKey()).toBe('mtproto_last_id:-100:55');
    mockDbPrepareGet.mockReturnValue({ value: '123' });
    expect(ing._getLastId()).toBe(123);
    ing._setLastId(200);
    expect(mockDbPrepareRun).toHaveBeenCalledWith('mtproto_last_id:-100:55', '200');

    expect(ing._inTopic({ id: 55, replyTo: {} })).toBe(true);
    expect(ing._inTopic({ id: 999, replyTo: { replyToTopId: 55 } })).toBe(true);
    expect(ing._inTopic({ id: 999, replyTo: { replyToTopId: 12 } })).toBe(false);
  });

  it('toDbMessage maps action topic create, entities, and date variants', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const ing = new TelegramUserIngestor({ apiId: '1', apiHash: 'h', phone: '+1', dbPath: '/tmp/x.db', chatId: '-100' });

    const nowDate = new Date('2026-01-01T00:00:00Z');
    const m1 = ing._toDbMessage({
      id: 10,
      chatId: '-100',
      senderId: 7,
      sender: { firstName: 'A' },
      message: 'hello',
      date: nowDate,
      entities: [{ className: 'MessageEntityUrl', offset: 0, length: 4, url: 'u' }],
      replyTo: { forumTopic: true, replyToMsgId: 77 },
    });
    expect(m1.timestamp).toBe(nowDate.getTime());
    expect(m1.topicId).toBe('77');

    const m2 = ing._toDbMessage({ id: 11, message: '', date: 1700000000, replyTo: { replyToTopId: 55 } });
    expect(m2.timestamp).toBe(1700000000 * 1000);
    expect(m2.topicId).toBe('55');

    const m3 = ing._toDbMessage({ id: 12, message: '', date: '2026-01-01T00:00:00Z', action: { className: 'MessageActionTopicCreate', title: 'Topic' }, replyTo: {} });
    expect(m3.topicId).toBe('12');
    expect(m3.rawMeta.topic_title).toBe('Topic');
  });

  it('downloads image media and stores media metadata', async () => {
    jest.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).includes('telegram_user.session'));
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    jest.spyOn(fs, 'statSync').mockReturnValue({ size: 1234 });

    const ing = new TelegramUserIngestor({ apiId: '1', apiHash: 'h', phone: '+1', dbPath: '/tmp/x.db', chatId: '-100' });
    const base = ing._toDbMessage({ id: 77, chatId: '-100', replyTo: { replyToTopId: 55 }, message: '', photo: { w: 800, h: 600 } });
    const out = await ing._attachImageMedia(base, { id: 77, photo: { w: 800, h: 600 } });

    expect(mockDownloadMedia).toHaveBeenCalled();
    expect(out.contentType).toBe('image');
    expect(out.mediaPath).toContain('telegram/-100/55/77.jpg');
    expect(out.mediaMime).toBe('image/jpeg');
    expect(out.mediaSize).toBe(1234);
    expect(out.mediaWidth).toBe(800);
    expect(out.mediaHeight).toBe(600);
  });

  it('syncOnce ingests messages and updates last id', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const ing = new TelegramUserIngestor({ apiId: '1', apiHash: 'h', phone: '+1', dbPath: '/tmp/x.db', chatId: '-100', topicId: '55' });

    mockGetEntity.mockResolvedValue({ id: 'chat' });
    mockDbPrepareGet.mockReturnValue({ value: '100' });

    mockIterMessagesImpl = async function* (_entity, opts) {
      expect(opts.minId).toBe(70);
      yield { id: 80, replyTo: { replyToTopId: 12 }, message: 'skip topic', chatId: '-100' };
      yield { id: 90, replyTo: { replyToTopId: 55 }, message: 'skip old window', chatId: '-100' };
      yield { id: 131, replyTo: { replyToTopId: 55 }, message: 'take', chatId: '-100' };
    };

    const out = await ing.syncOnce({ backfillLimit: 200, replayBuffer: 30 });
    expect(out.ingested).toBe(2);
    expect(out.lastId).toBe(131);
    expect(mockInsertMessage).toHaveBeenCalledTimes(2);
    expect(mockDbPrepareRun).toHaveBeenCalledWith('mtproto_last_id:-100:55', '131');
  });

  it('syncOnce supports first-time unlimited backfill branch', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const ing = new TelegramUserIngestor({ apiId: '1', apiHash: 'h', phone: '+1', dbPath: '/tmp/x.db', chatId: '-100' });
    mockGetEntity.mockResolvedValue({ id: 'chat' });
    mockDbPrepareGet.mockReturnValue({ value: '0' });

    mockIterMessagesImpl = async function* (_entity, opts) {
      expect(opts.reverse).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(opts, 'limit')).toBe(false);
      yield { id: 1, message: 'x', chatId: '-100', replyTo: {} };
    };

    const out = await ing.syncOnce({ backfillLimit: 0, replayBuffer: 0 });
    expect(out.ingested).toBe(1);
  });

  it('runLoop executes sync and breaks on timer error', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const ing = new TelegramUserIngestor({ apiId: '1', apiHash: 'h', phone: '+1', dbPath: '/tmp/x.db', chatId: '-100' });
    ing.syncOnce = jest.fn().mockRejectedValue(new Error('boom'));

    const timerSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => {
      throw new Error('stop-loop');
    });

    await expect(ing.runLoop({ intervalMs: 1 })).rejects.toThrow('stop-loop');
    expect(ing.syncOnce).toHaveBeenCalled();
    timerSpy.mockRestore();
  });
});
