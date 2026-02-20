const express = require('express');
const path = require('path');
const { Database } = require('../db/Database');
const { TreeNavigator } = require('../core/TreeNavigator');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/portal.db');

// Ensure data dir exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../web/public')));

// --- Helper: build tree view from DB messages ---

function buildTree(source, channel) {
  const messages = db.getMessages(source, channel);
  const nav = new TreeNavigator();

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

    nav.addMessage({
      id: msg.id,
      sender,
      replyToId: msg.reply_to_id || null,
      content: msg.content,
      timestamp: msg.timestamp,
    });
  }

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
  res.json(db.getTelegramTopics(chatId));
});

/** Get tree for a source+channel */
app.get('/api/sources/:source/channels/:channel/tree', (req, res) => {
  const nav = buildTree(req.params.source, req.params.channel);
  res.json(nav.getTree());
});

/** Get a layer for a source+channel */
app.get('/api/sources/:source/channels/:channel/layers/:layerId', (req, res) => {
  const nav = buildTree(req.params.source, req.params.channel);
  const layer = nav.getLayer(req.params.layerId);
  if (!layer) return res.status(404).json({ error: 'Layer not found' });
  res.json(layer);
});

/** Get all layers for a source+channel (full view) */
app.get('/api/sources/:source/channels/:channel/view', (req, res) => {
  const nav = buildTree(req.params.source, req.params.channel);
  res.json({
    tree: nav.getTree(),
    currentLayerId: nav.getCurrentLayerId(),
    state: nav.exportState(),
  });
});

/** Ingest messages (generic) */
app.post('/api/ingest', (req, res) => {
  const messages = Array.isArray(req.body) ? req.body : [req.body];
  let count = 0;
  for (const msg of messages) {
    if (!msg.id || !msg.source || !msg.channel || !msg.senderId || !msg.content || !msg.timestamp) {
      continue;
    }
    db.insertMessage(msg);
    count++;
  }
  res.json({ ingested: count });
});

/** Ingest Telegram messages */
app.post('/api/ingest/telegram', (req, res) => {
  const { TelegramAdapter } = require('../ingestion/TelegramAdapter');
  const selfUserId = req.query.selfUserId || req.body.selfUserId;
  const adapter = new TelegramAdapter(db, { selfUserId });
  const messages = req.body.messages || (Array.isArray(req.body) ? req.body : [req.body]);
  const ingested = adapter.ingestBatch(messages);
  res.json({ ingested: ingested.length });
});

/** Raw messages for a channel (for debugging) */
app.get('/api/sources/:source/channels/:channel/messages', (req, res) => {
  res.json(db.getMessages(req.params.source, req.params.channel));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`knowledge-portal running on http://localhost:${PORT}`);
});
