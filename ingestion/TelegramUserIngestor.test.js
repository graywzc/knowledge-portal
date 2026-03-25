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



  it('syncOnce continues when image download fails and advances last id', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    mockDownloadMedia.mockRejectedValue(new Error('download failed'));

    const ing = new TelegramUserIngestor({ apiId: '1', apiHash: 'h', phone: '+1', dbPath: '/tmp/x.db', chatId: '-100' });
    mockGetEntity.mockResolvedValue({ id: 'chat' });
    mockDbPrepareGet.mockReturnValue({ value: '100' });

    mockIterMessagesImpl = async function* () {
      yield { id: 131, replyTo: { replyToTopId: 55 }, message: '', photo: { w: 100, h: 80 }, chatId: '-100' };
      yield { id: 132, replyTo: { replyToTopId: 55 }, message: 'after-fail', chatId: '-100' };
    };

    const out = await ing.syncOnce({ backfillLimit: 200, replayBuffer: 30 });
    expect(out.ingested).toBe(2);
    expect(out.lastId).toBe(132);
    expect(mockInsertMessage).toHaveBeenCalledTimes(2);

    const first = mockInsertMessage.mock.calls[0][0];
    expect(first.contentType).toBe('image');
    expect(first.mediaPath).toBeNull();
    expect(first.rawMeta.media_kind).toBe('photo');

    expect(mockDbPrepareRun).toHaveBeenCalledWith('mtproto_last_id:-100:all', '132');
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
