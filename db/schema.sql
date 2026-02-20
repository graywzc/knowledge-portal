-- Source-agnostic message store
-- Raw chat data, flat, no tree logic here

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,        -- unique message id (source-prefixed, e.g. "tg:12345")
  source        TEXT NOT NULL,           -- data source identifier (e.g. "telegram", "slack")
  channel       TEXT NOT NULL,           -- legacy scope key (topic_id if present else chat_id)
  chat_id       TEXT,                    -- container/chat id (e.g. telegram group id)
  topic_id      TEXT,                    -- optional sub-thread/topic id inside chat
  sender_id     TEXT NOT NULL,           -- who sent it (source-specific user id)
  sender_name   TEXT,                    -- display name (denormalized for convenience)
  sender_role   TEXT NOT NULL DEFAULT 'user',  -- "self" or "user" or "bot" etc.
  reply_to_id   TEXT,                    -- id of message being replied to (null if none)
  content       TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'text',  -- "text", "image", "file", etc.
  timestamp     INTEGER NOT NULL,        -- epoch ms
  raw_meta      TEXT,                    -- source-specific metadata as JSON
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(source, channel);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to_id);
