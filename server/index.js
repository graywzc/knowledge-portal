const express = require('express');
const path = require('path');
const { Database } = require('../db/Database');
const { TreeNavigator } = require('../core/TreeNavigator');
const { TelegramSender } = require('../services/TelegramSender');

const PORT = process.env.PORT || 3000;

function createApp({ dbPath, telegramSender } = {}) {
  const app = express();
  const DB_PATH = dbPath || process.env.DB_PATH || path.join(__dirname, '../data/portal.db');

  // Ensure data dir exists
  const fs = require('fs');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);
  const sender = telegramSender || new TelegramSender();

  app.use(express.json({ limit: '15mb' }));
  app.use(express.static(path.join(__dirname, '../web/public')));

  const MEDIA_ROOT = process.env.MEDIA_ROOT || path.join(process.cwd(), 'media');
  app.use('/media', express.static(MEDIA_ROOT));

// --- Helper: build tree view from DB messages ---

function buildTree(source, channel) {
  const messages = db.getMessages(source, channel);
  const rootMessageId = (() => {
    if (String(source) === 'telegram') {
      const first = messages[0] || null;
      const chatId = first?.chat_id ? String(first.chat_id) : String(process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID || 'unknown-chat');
      return `tg:${chatId}:${channel}`;
    }
    return `${source}:${channel}:root`;
  })();
  const nav = new TreeNavigator({ source, channel, rootMessageId });

  // Perspective user id: whose "self" rules should be used for branch/jump logic.
  // Can be overridden by env (recommended), else defaults to the most frequent sender in channel.
  const configuredViewerId = process.env.PORTAL_VIEWER_USER_ID || null;
  let viewerId = configuredViewerId;
  if (!viewerId && messages.length) {
    const counts = new Map();
    for (const m of messages) counts.set(m.sender_id, (counts.get(m.sender_id) || 0) + 1);
    viewerId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  const botIds = new Set(
    String(process.env.PORTAL_BOT_USER_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );

  for (const msg of messages) {
    const senderId = String(msg.sender_id);
    const sender = senderId === String(viewerId)
      ? 'self'
      : (botIds.has(senderId) ? 'bot' : 'other');

    let entities = null;
    try {
      const meta = msg.raw_meta ? JSON.parse(msg.raw_meta) : null;
      entities = Array.isArray(meta?.entities) ? meta.entities : null;
    } catch {}

    nav.addMessage({
      id: msg.id,
      sender,
      replyToId: msg.reply_to_id || null,
      content: msg.content,
      contentType: msg.content_type || 'text',
      mediaPath: msg.media_path || null,
      mediaMime: msg.media_mime || null,
      mediaWidth: msg.media_width,
      mediaHeight: msg.media_height,
      timestamp: msg.timestamp,
      entities,
    });
  }

  const state = nav.exportState();
  db.upsertLayers(source, channel, Object.values(state.layers));

  return nav;
}

// --- API Routes ---

/** List sources */
app.get('/api/sources', (req, res) => {
  res.json(db.getSources());
});

/** List channels for a source */
app.get('/api/sources/:source/channels', (req, res) => {
  res.json(db.getChannels(req.params.source));
});

/** List telegram topics (ordered by most recent) */
app.get('/api/telegram/topics', (req, res) => {
  const chatId = req.query.chatId || process.env.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || db.getPrimaryTelegramChatId();
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  const includeArchived = String(req.query.includeArchived || '').toLowerCase() === 'true';
  res.json(db.getTelegramTopics(chatId, { includeArchived }));
});

/** Get tree for a source+channel */
app.get('/api/sources/:source/channels/:channel/tree', (req, res) => {
  const nav = buildTree(req.params.source, req.params.channel);
  res.json(nav.getTree());
});

/** Get a layer for a source+channel */
app.get('/api/sources/:source/channels/:channel/layers/:layerUuid', (req, res) => {
  const nav = buildTree(req.params.source, req.params.channel);
  const layer = nav.getLayer(req.params.layerUuid);
  if (!layer) return res.status(404).json({ error: 'Layer not found' });
  res.json(layer);
});

/** Get all layers for a source+channel (full view) */
app.get('/api/sources/:source/channels/:channel/view', (req, res) => {
  const nav = buildTree(req.params.source, req.params.channel);
  res.json({
    tree: nav.getTree(),
    currentLayerUuid: nav.getCurrentLayerUuid(),
    state: nav.exportState(),
  });
});

/** Get layer done statuses for a scope */
app.get('/api/layers/status', (req, res) => {
  const source = String(req.query.source || '');
  const channel = String(req.query.channel || '');
  if (!source || !channel) return res.status(400).json({ error: 'source and channel required' });

  const rows = db.getLayerStatuses(source, channel);
  const layers = {};
  for (const r of rows) {
    layers[String(r.layer_uuid)] = {
      done: !!r.done,
      updatedAt: Number(r.updated_at || 0),
    };
  }

  res.json({ ok: true, source, channel, layers });
});

/** Toggle layer done */
app.post('/api/layers/:layerUuid/done', (req, res) => {
  const layerUuid = String(req.params.layerUuid || '');
  const source = String(req.body?.source || '');
  const channel = String(req.body?.channel || '');
  const done = req.body?.done;

  if (!layerUuid) return res.status(400).json({ error: 'layerUuid required' });
  if (!source || !channel) return res.status(400).json({ error: 'source and channel required' });
  if (typeof done !== 'boolean') return res.status(400).json({ error: 'done must be boolean' });

  const out = db.setLayerDone(source, channel, layerUuid, done);
  res.json(out);
});

/** Raw messages for a channel (for debugging) */
app.get('/api/sources/:source/channels/:channel/messages', (req, res) => {
  res.json(db.getMessages(req.params.source, req.params.channel));
});

/** Realtime stream for one source/channel (SSE) */
app.get('/api/stream', (req, res) => {
  const source = String(req.query.source || '');
  const channel = String(req.query.channel || '');
  if (!source || !channel) return res.status(400).json({ error: 'source and channel required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const writeUpdate = () => {
    const data = JSON.stringify({ source, channel, at: Date.now() });
    res.write(`event: update\ndata: ${data}\n\n`);
  };

  let lastSig = db.getChannelSignature(source, channel);
  res.write(`event: ready\ndata: ${JSON.stringify({ source, channel })}\n\n`);

  const timer = setInterval(() => {
    const nextSig = db.getChannelSignature(source, channel);
    if (nextSig !== lastSig) {
      lastSig = nextSig;
      writeUpdate();
    } else {
      res.write(': keep-alive\n\n');
    }
  }, 1200);

  req.on('close', () => {
    clearInterval(timer);
  });
});

/** Create telegram forum topic */
app.post('/api/telegram/topics/create', async (req, res) => {
  try {
    const { chatId, title } = req.body || {};
    const resolvedChatId = chatId
      || process.env.TG_CHAT_ID
      || process.env.TELEGRAM_CHAT_ID
      || db.getPrimaryTelegramChatId();

    if (!resolvedChatId) return res.status(400).json({ error: 'chatId required' });
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
    if (String(title).trim().length > 128) return res.status(400).json({ error: 'title too long (max 128)' });

    const result = await sender.createTopic({
      chatId: String(resolvedChatId),
      title: String(title).trim(),
    });

    if (result?.topicId) {
      const topicUUID = db.getOrCreateTopicUUID('telegram', String(resolvedChatId), String(result.topicId));
      return res.json({ ...result, topicUUID });
    }

    return res.json(result);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('required')) return res.status(400).json({ error: msg });
    return res.status(500).json({ error: 'telegram topic create failed', detail: msg });
  }
});

/** Archive/unarchive a topic in KP sidebar */
app.post('/api/topics/:topicUUID/archive', (req, res) => {
  const topicUUID = String(req.params.topicUUID || '');
  if (!topicUUID) return res.status(400).json({ error: 'topicUUID required' });

  const t = db.getTopicByUUID(topicUUID);
  if (!t) return res.status(404).json({ error: 'topic not found' });

  const archived = (typeof req.body?.archived === 'boolean') ? req.body.archived : true;
  db.setTopicArchived(topicUUID, archived);
  return res.json({ ok: true, topicUUID, archived });
});

/** Delete topic on Telegram and mark deleted_at in KP */
app.post('/api/topics/:topicUUID/delete', async (req, res) => {
  try {
    const topicUUID = String(req.params.topicUUID || '');
    if (!topicUUID) return res.status(400).json({ error: 'topicUUID required' });

    const topic = db.getTopicByUUID(topicUUID);
    if (!topic) return res.status(404).json({ error: 'topic not found' });
    if (topic.source !== 'telegram') return res.status(400).json({ error: 'only telegram topic delete supported' });
    if (topic.deleted_at) return res.status(400).json({ error: 'topic already deleted' });

    const reqChatId = req.body?.chatId;
    const reqTopicId = req.body?.topicId;

    const chatId = String(reqChatId || process.env.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || db.getPrimaryTelegramChatId() || '');
    const topicId = Number(reqTopicId);
    if (!chatId) return res.status(400).json({ error: 'chatId required' });
    if (!Number.isFinite(topicId)) return res.status(400).json({ error: 'topicId required' });

    await sender.deleteTopic({ chatId, topicId });
    db.setTopicDeletedAt(topicUUID, Date.now());

    return res.json({ ok: true, topicUUID, deletedAt: db.getTopicByUUID(topicUUID)?.deleted_at || null });
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('required')) return res.status(400).json({ error: msg });
    return res.status(500).json({ error: 'telegram topic delete failed', detail: msg });
  }
});

/** Send telegram image (clipboard data url) */
app.post('/api/telegram/send-image', async (req, res) => {
  try {
    const { chatId, dataUrl, caption, replyToId } = req.body || {};

    const resolvedChatId = chatId
      || process.env.TG_CHAT_ID
      || process.env.TELEGRAM_CHAT_ID
      || db.getPrimaryTelegramChatId();

    if (!resolvedChatId) return res.status(400).json({ error: 'chatId required' });
    if (!dataUrl || !String(dataUrl).startsWith('data:image/')) return res.status(400).json({ error: 'dataUrl image required' });

    const m = String(dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'invalid dataUrl format' });
    const mimeType = m[1];
    const b64 = m[2];
    const imageBuffer = Buffer.from(b64, 'base64');
    if (!imageBuffer.length) return res.status(400).json({ error: 'invalid image data' });

    const result = await sender.sendImage({
      chatId: String(resolvedChatId),
      imageBuffer,
      mimeType,
      caption: String(caption || ''),
      replyToId,
    });

    return res.json(result);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('required') || msg.includes('invalid')) return res.status(400).json({ error: msg });
    return res.status(500).json({ error: 'telegram image send failed', detail: msg });
  }
});

/** Send telegram message (text only) */
app.post('/api/telegram/send', async (req, res) => {
  try {
    const { chatId, text, replyToId } = req.body || {};
    const resolvedChatId = chatId
      || process.env.TG_CHAT_ID
      || process.env.TELEGRAM_CHAT_ID
      || db.getPrimaryTelegramChatId();

    if (!resolvedChatId) return res.status(400).json({ error: 'chatId required' });
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
    if (String(text).length > 4096) return res.status(400).json({ error: 'text too long (max 4096)' });

    const replyTopicId = Number(replyToId);
    if (Number.isFinite(replyTopicId) && db.isTelegramTopicDeleted(String(resolvedChatId), String(replyTopicId))) {
      return res.status(409).json({ error: 'topic is deleted on telegram; chat is read-only' });
    }

    const result = await sender.sendText({
      chatId: String(resolvedChatId),
      text: String(text),
      replyToId,
    });

    return res.json(result);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('required') || msg.includes('must be a numeric')) {
      return res.status(400).json({ error: msg });
    }
    return res.status(500).json({ error: 'telegram send failed', detail: msg });
  }
});

  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`knowledge-portal running on http://localhost:${PORT}`);
  });
}

module.exports = { createApp };
