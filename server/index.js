const express = require('express');
const path = require('path');
const { TreeNavigator } = require('../core/TreeNavigator');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../web/public')));

// In-memory store (swap with DB adapter later)
let navigator = new TreeNavigator();

// --- API Routes ---

/** Add a message */
app.post('/api/messages', (req, res) => {
  const { id, sender, replyToId, content, timestamp } = req.body;
  if (!id || !sender || !content) {
    return res.status(400).json({ error: 'id, sender, content required' });
  }
  const result = navigator.addMessage({
    id,
    sender,
    replyToId: replyToId || null,
    content,
    timestamp: timestamp || Date.now(),
  });
  res.json(result);
});

/** Get a layer */
app.get('/api/layers/:id', (req, res) => {
  const layer = navigator.getLayer(req.params.id);
  if (!layer) return res.status(404).json({ error: 'Layer not found' });
  res.json(layer);
});

/** Get the tree structure */
app.get('/api/tree', (req, res) => {
  res.json(navigator.getTree());
});

/** Get current layer */
app.get('/api/current', (req, res) => {
  const id = navigator.getCurrentLayerId();
  res.json({ currentLayerId: id, layer: navigator.getLayer(id) });
});

/** Export state */
app.get('/api/state', (req, res) => {
  res.json(navigator.exportState());
});

/** Import state */
app.post('/api/state', (req, res) => {
  try {
    navigator = TreeNavigator.fromState(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Reset */
app.post('/api/reset', (req, res) => {
  navigator = new TreeNavigator();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`knowledge-portal running on http://localhost:${PORT}`);
});
