-- Source-agnostic message store
-- Raw communications from any source, flat, no tree logic here

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,        -- uuidv5(KP_NS, source_natural_key) for new messages
  source        TEXT NOT NULL,           -- "telegram" | "claude"
  sender_id     TEXT NOT NULL,           -- source-specific user/agent id
  sender_name   TEXT,                    -- display name (denormalized)
  sender_role   TEXT NOT NULL DEFAULT 'user',  -- "self" | "user" | "bot"
  parent_id     TEXT,                    -- kp display parent (FK → messages.id); null = root
  branched      INTEGER,                 -- NULL = infer from sender rules; 0 = same layer; 1 = new sub-layer
  content       TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'text',  -- "text" | "image" | "file"
  timestamp     INTEGER NOT NULL,        -- epoch ms
  meta          TEXT,                    -- source-specific JSON (reply_to_id, parent_uuid, media_path, etc.)
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

CREATE TABLE IF NOT EXISTS topics (
  id              TEXT PRIMARY KEY,   -- root message UUID (messages.id); topic IS its root message
  parent_topic_id TEXT,               -- null = top-level (searchable); set = sub-topic (hidden)
  name            TEXT,               -- user-searchable title
  meta            TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  deleted_at      INTEGER,            -- epoch ms; null = not deleted
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);


CREATE TABLE IF NOT EXISTS layers (
  id               TEXT PRIMARY KEY,
  first_message_id TEXT,               -- FK → messages.id
  parent_layer_id  TEXT,               -- FK → layers.id
  title            TEXT,
  done             INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
