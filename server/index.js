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

function buildTree(source, channel, selfUserId) {
  const messages = db.getMessages(source, channel);
  const nav = new TreeNavigator();

  for (const msg of messages) {
    nav.addMessage({
      id: msg.id,
      sender: msg.sender_role === 'self' ? 'self' : 'other',
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

app.listen(PORT, () => {
  console.log(`knowledge-portal running on http://localhost:${PORT}`);
});
