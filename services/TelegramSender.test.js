const fs = require('fs');

const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
const mockGetEntity = jest.fn();
const mockSendMessage = jest.fn();
const mockInvoke = jest.fn();

jest.mock('telegram', () => ({
  TelegramClient: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    getEntity: mockGetEntity,
    sendMessage: mockSendMessage,
    invoke: mockInvoke,
  })),
  Api: {
    channels: {
      CreateForumTopic: class {
        constructor(args) { this.args = args; }
      },
    },
  },
}));

jest.mock('telegram/sessions', () => ({
  StringSession: jest.fn().mockImplementation((v) => ({ value: v })),
}));

const { TelegramSender } = require('./TelegramSender');

describe('TelegramSender', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('session-token');
    mockConnect.mockResolvedValue(undefined);
    mockDisconnect.mockResolvedValue(undefined);
    mockGetEntity.mockResolvedValue({ id: 'entity' });
    mockSendMessage.mockResolvedValue({ id: 4321 });
    mockInvoke.mockResolvedValue({ updates: [] });
  });

  it('creates forum topic via MTProto', async () => {
    mockInvoke.mockResolvedValueOnce({
      updates: [
        {
          message: {
            id: 41,
            action: { className: 'MessageActionTopicCreate', title: 'Old Topic' },
          },
        },
        {
          message: {
            id: 55,
            action: { className: 'MessageActionTopicCreate', title: 'New Topic' },
          },
        },
      ],
    });

    const sender = new TelegramSender({ apiId: '1', apiHash: 'h', sessionPath: '/tmp/session' });
    const out = await sender.createTopic({ chatId: '-100', title: 'New Topic' });

    expect(mockInvoke).toHaveBeenCalled();
    expect(out).toEqual({
      ok: true,
      chatId: '-100',
      title: 'New Topic',
      topicId: 55,
    });
  });

  it('sends plain message without forcing reply target', async () => {
    const sender = new TelegramSender({ apiId: '1', apiHash: 'h', sessionPath: '/tmp/session' });
    const out = await sender.sendText({ chatId: '-100', text: 'hello' });

    expect(mockSendMessage).toHaveBeenCalledWith({ id: 'entity' }, {
      message: 'hello',
    });
    expect(out.ok).toBe(true);
    expect(out.telegramMessageId).toBe(4321);
    expect(out.chatId).toBe('-100');
    expect(out.replyToId).toBe(null);
  });

  it('uses explicit numeric replyToId when provided', async () => {
    const sender = new TelegramSender({ apiId: '1', apiHash: 'h', sessionPath: '/tmp/session' });
    await sender.sendText({ chatId: '-100', text: 'reply', replyToId: '999' });

    expect(mockSendMessage).toHaveBeenCalledWith({ id: 'entity' }, {
      message: 'reply',
      replyTo: 999,
    });
  });

  it('validates required chat/text fields', async () => {
    const sender = new TelegramSender({ apiId: '1', apiHash: 'h', sessionPath: '/tmp/session' });
    await expect(sender.sendText({ chatId: '', text: 'x' })).rejects.toThrow('chatId required');
    await expect(sender.sendText({ chatId: '-100', text: '' })).rejects.toThrow('text required');
  });

  it('rejects non-numeric replyToId', async () => {
    const sender = new TelegramSender({ apiId: '1', apiHash: 'h', sessionPath: '/tmp/session' });
    await expect(sender.sendText({ chatId: '-100', text: 'x', replyToId: 'tg:-100:999' }))
      .rejects.toThrow('replyToId must be a numeric Telegram message id');
  });
});
