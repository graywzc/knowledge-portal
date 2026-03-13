const path = require('path');

function withProcessState({ argv, env }, fn) {
  const oldArgv = process.argv;
  const oldEnv = process.env;
  process.argv = argv;
  process.env = { ...oldEnv, ...env };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.argv = oldArgv;
      process.env = oldEnv;
    });
}

describe('scripts', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });


  it('mtproto-sync.js runs loop mode', async () => {
    await withProcessState(
      {
        argv: ['node', 'scripts/mtproto-sync.js', 'loop'],
        env: { TG_CHAT_ID: '-100', TG_API_ID: '1', TG_API_HASH: 'h' },
      },
      async () => {
        const mockStart = jest.fn().mockResolvedValue();
        const mockLoop = jest.fn().mockResolvedValue();
        const mockSyncOnce = jest.fn().mockResolvedValue();
        const mockDisconnect = jest.fn().mockResolvedValue();

        const MockIngestor = jest.fn().mockImplementation(() => ({
          start: mockStart,
          runLoop: mockLoop,
          syncOnce: mockSyncOnce,
          client: { disconnect: mockDisconnect },
        }));

        jest.doMock('fs', () => ({ existsSync: () => false, readFileSync: () => '' }));
        jest.doMock('../ingestion/TelegramUserIngestor', () => ({ TelegramUserIngestor: MockIngestor }));

        jest.isolateModules(() => {
          require('./mtproto-sync');
        });

        await new Promise((r) => setTimeout(r, 0));

        expect(mockStart).toHaveBeenCalled();
        expect(mockLoop).toHaveBeenCalled();
        expect(mockSyncOnce).not.toHaveBeenCalled();
      }
    );
  });

  it('reset-last-id.js updates state value', async () => {
    await withProcessState(
      {
        argv: ['node', 'scripts/reset-last-id.js', '123'],
        env: { TG_CHAT_ID: '-100', DB_PATH: 'data/dev.db' },
      },
      async () => {
        const getMock = jest
          .fn()
          .mockReturnValueOnce({ value: '100' })
          .mockReturnValueOnce({ value: '123' });
        const runMock = jest.fn();

        const mockDb = {
          db: {
            exec: jest.fn(),
            prepare: jest.fn((sql) => {
              if (sql.includes('SELECT value')) return { get: getMock };
              return { run: runMock };
            }),
          },
          close: jest.fn(),
        };

        const MockDatabase = jest.fn().mockImplementation(() => mockDb);

        jest.doMock('fs', () => ({ existsSync: () => false, readFileSync: () => '' }));
        jest.doMock('../db/Database', () => ({ Database: MockDatabase }));

        jest.isolateModules(() => {
          require('./reset-last-id');
        });

        expect(MockDatabase).toHaveBeenCalledWith('data/dev.db');
        expect(runMock).toHaveBeenCalledWith('mtproto_last_id:-100:all', '123');
        expect(mockDb.close).toHaveBeenCalled();
      }
    );
  });
});
