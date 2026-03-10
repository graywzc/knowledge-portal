const https = require('https');

const mockDbPrepareGet = jest.fn();
const mockDbPrepareRun = jest.fn();

jest.mock('../db/Database', () => {
  return {
    Database: jest.fn().mockImplementation(() => ({
      db: {
        exec: jest.fn(),
        prepare: jest.fn((sql) => {
          if (sql.includes('SELECT value FROM poller_state')) {
            return { get: mockDbPrepareGet };
          }
          return { run: mockDbPrepareRun };
        }),
      },
    })),
  };
});

const mockIngest = jest.fn();
jest.mock('./TelegramAdapter', () => ({
  TelegramAdapter: jest.fn().mockImplementation(() => ({ ingest: mockIngest })),
}));

const { TelegramPoller } = require('./TelegramPoller');

describe('TelegramPoller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDbPrepareGet.mockReturnValue(null);
    mockIngest.mockReturnValue({ id: 'ok' });
  });

  it('loads persisted offset in constructor and can save offset', () => {
    mockDbPrepareGet.mockReturnValue({ value: '42' });
    const poller = new TelegramPoller({ token: 't', dbPath: '/tmp/x.db', chatId: '-100' });

    expect(poller.offset).toBe(42);
    poller.offset = 99;
    poller._saveOffset();
    expect(mockDbPrepareRun).toHaveBeenCalledWith('offset', '99');
  });

  it('apiCall resolves successful telegram response', async () => {
    jest.spyOn(https, 'get').mockImplementation((url, cb) => {
      const handlers = {};
      const res = { on: (ev, fn) => { handlers[ev] = fn; } };
      cb(res);
      handlers.data('{"ok":true,"result":[1,2]}');
      handlers.end();
      return { on: jest.fn() };
    });

    const poller = new TelegramPoller({ token: 't', dbPath: '/tmp/x.db' });
    await expect(poller._apiCall('getMe')).resolves.toEqual([1, 2]);
  });

  it('apiCall rejects telegram API errors and JSON parse errors', async () => {
    jest.spyOn(https, 'get').mockImplementationOnce((url, cb) => {
      const handlers = {};
      cb({ on: (ev, fn) => { handlers[ev] = fn; } });
      handlers.data('{"ok":false,"description":"bad"}');
      handlers.end();
      return { on: jest.fn() };
    }).mockImplementationOnce((url, cb) => {
      const handlers = {};
      cb({ on: (ev, fn) => { handlers[ev] = fn; } });
      handlers.data('not-json');
      handlers.end();
      return { on: jest.fn() };
    });

    const poller = new TelegramPoller({ token: 't', dbPath: '/tmp/x.db' });
    await expect(poller._apiCall('x')).rejects.toThrow('Telegram API error');
    await expect(poller._apiCall('x')).rejects.toThrow();
  });

  it('start ingests updates and advances offset with chat filtering', async () => {
    const poller = new TelegramPoller({ token: 't', dbPath: '/tmp/x.db', chatId: '-100' });

    poller._apiCall = jest
      .fn()
      .mockResolvedValueOnce({ username: 'bot', id: 1 })
      .mockImplementationOnce(async () => {
        poller.running = false;
        return [
          { update_id: 10, message: { chat: { id: -100 }, text: 'ok' } },
          { update_id: 11, message: { chat: { id: -200 }, text: 'skip' } },
        ];
      });

    await poller.start();

    expect(mockIngest).toHaveBeenCalledTimes(1);
    expect(poller.offset).toBe(11);
    expect(mockDbPrepareRun).toHaveBeenCalled();
  });

  it('start handles errors and retries with sleep', async () => {
    const poller = new TelegramPoller({ token: 't', dbPath: '/tmp/x.db', retryDelay: 1 });
    poller._apiCall = jest
      .fn()
      .mockRejectedValueOnce(new Error('getMe fail'))
      .mockRejectedValueOnce(new Error('loop fail'));
    poller._sleep = jest.fn().mockImplementation(async () => {
      poller.running = false;
    });

    await poller.start();
    expect(poller._sleep).toHaveBeenCalledWith(1);
  });

  it('stop flips running flag and sleep resolves', async () => {
    const poller = new TelegramPoller({ token: 't', dbPath: '/tmp/x.db' });
    poller.running = true;
    poller.stop();
    expect(poller.running).toBe(false);
    await expect(poller._sleep(0)).resolves.toBeUndefined();
  });
});
