/**
 * Seed script — populates mock data for development/testing.
 * Run: npm run seed
 * Uses data/dev.db (never touches production DB).
 */

const path = require('path');
const { Database } = require('../db/Database');

const DB_PATH = path.join(__dirname, '../data/dev.db');
const db = new Database(DB_PATH);

// Simulate a conversation between "Larry" (self) and "Bot" (other/bot)
// that exercises all three navigation rules:
//   - plain messages (append)
//   - reply to other's message (branch)
//   - reply to own message (jump back)

const messages = [
  // --- Layer A: top-level conversation about system design ---
  { id: 'mock:1',  source: 'mock', channel: 'design-chat', senderId: 'larry',  senderName: 'Larry', senderRole: 'self', replyToId: null,     content: 'Let\'s design the knowledge portal architecture', timestamp: 1000 },
  { id: 'mock:2',  source: 'mock', channel: 'design-chat', senderId: 'bot',    senderName: 'Bot',   senderRole: 'other', replyToId: null,     content: 'Sure. I suggest separating persistence from display logic. The DB stores flat messages, and a TreeNavigator builds the hierarchy at query time.', timestamp: 2000 },
  { id: 'mock:3',  source: 'mock', channel: 'design-chat', senderId: 'larry',  senderName: 'Larry', senderRole: 'self', replyToId: null,     content: 'What about the tech stack?', timestamp: 3000 },
  { id: 'mock:4',  source: 'mock', channel: 'design-chat', senderId: 'bot',    senderName: 'Bot',   senderRole: 'other', replyToId: null,     content: 'Node.js + SQLite + Express for now. Core logic is pure JS so it can be consumed by iOS later.', timestamp: 4000 },

  // --- Layer B: Larry replies to Bot's architecture answer (mock:2) → branches into sub-layer ---
  { id: 'mock:5',  source: 'mock', channel: 'design-chat', senderId: 'larry',  senderName: 'Larry', senderRole: 'self', replyToId: 'mock:2', content: 'Tell me more about the TreeNavigator. How does branching work?', timestamp: 5000 },
  { id: 'mock:6',  source: 'mock', channel: 'design-chat', senderId: 'bot',    senderName: 'Bot',   senderRole: 'other', replyToId: null,     content: 'When you reply to someone else\'s message, it creates a new sub-layer. Reply to your own message to jump back to that layer.', timestamp: 6000 },
  { id: 'mock:7',  source: 'mock', channel: 'design-chat', senderId: 'larry',  senderName: 'Larry', senderRole: 'self', replyToId: null,     content: 'Got it. And the navigation strategy is pluggable?', timestamp: 7000 },
  { id: 'mock:8',  source: 'mock', channel: 'design-chat', senderId: 'bot',    senderName: 'Bot',   senderRole: 'other', replyToId: null,     content: 'Yes, DefaultNavigationStrategy can be swapped for any custom logic.', timestamp: 8000 },

  // --- Layer C: Larry replies to Bot's strategy answer (mock:8) → deeper branch ---
  { id: 'mock:9',  source: 'mock', channel: 'design-chat', senderId: 'larry',  senderName: 'Larry', senderRole: 'self', replyToId: 'mock:8', content: 'What would an alternative strategy look like?', timestamp: 9000 },
  { id: 'mock:10', source: 'mock', channel: 'design-chat', senderId: 'bot',    senderName: 'Bot',   senderRole: 'other', replyToId: null,     content: 'For example, a "flat" strategy that ignores replies and puts everything in one layer. Or a "thread" strategy that branches on every reply regardless of sender.', timestamp: 10000 },

  // --- Jump back to Layer A: Larry replies to his own message (mock:3) ---
  { id: 'mock:11', source: 'mock', channel: 'design-chat', senderId: 'larry',  senderName: 'Larry', senderRole: 'self', replyToId: 'mock:3', content: 'Actually, let\'s also discuss the database schema', timestamp: 11000 },
  { id: 'mock:12', source: 'mock', channel: 'design-chat', senderId: 'bot',    senderName: 'Bot',   senderRole: 'other', replyToId: null,     content: 'The schema is a single flat messages table — source-agnostic, with reply_to_id for linking. No tree logic in the DB.', timestamp: 12000 },

  // --- Layer D: branch from Bot's schema answer (mock:12) ---
  { id: 'mock:13', source: 'mock', channel: 'design-chat', senderId: 'larry',  senderName: 'Larry', senderRole: 'self', replyToId: 'mock:12', content: 'Should we add a separate table for channels/sources?', timestamp: 13000 },
  { id: 'mock:14', source: 'mock', channel: 'design-chat', senderId: 'bot',    senderName: 'Bot',   senderRole: 'other', replyToId: null,      content: 'Not yet — we can derive them from the messages table. Add metadata tables when we need them.', timestamp: 14000 },
];

db.insertMessages(messages);

console.log(`Seeded ${messages.length} mock messages into ${DB_PATH}`);
console.log('Start with: DB_PATH=data/dev.db npm run dev');

db.close();
