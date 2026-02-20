# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
npm run dev          # dev server with file-watching (uses data/dev.db, port 3001)
npm start            # production server (uses data/portal.db)
npm test             # run tests (Node built-in test runner)
npm run seed         # seed dev.db with mock data

# Telegram ingestion
npm run poll         # Bot API long-polling (limited: misses messages to other bots)
npm run mtproto:once # MTProto user-account sync — one-shot (recommended first run)
npm run mtproto:loop # MTProto continuous sync loop
```

The dev server reads `DB_PATH` from the environment. The production server uses `data/portal.db`; override with `DB_PATH=...`.

## Architecture

The system has three layers that are strictly decoupled:

**`core/TreeNavigator.js`** — pure logic, no I/O deps. Takes a flat sequence of messages and organizes them into a tree of *layers* (labeled A, B, C, ...). Navigation decisions are delegated to a pluggable `NavigationStrategy`. The `DefaultNavigationStrategy` implements three rules: no-reply → append to current layer; reply to other's message → branch (new child layer); reply to own message → jump back to that layer. `TreeNavigator` is stateless-between-requests: the server rebuilds it from DB on every API call.

**`db/`** — SQLite persistence via `better-sqlite3`. `Database.js` auto-applies `schema.sql` on construction (idempotent via `CREATE TABLE IF NOT EXISTS`). The schema is source-agnostic: all messages live in one `messages` table keyed by a source-prefixed ID (e.g. `tg:{chatId}:{messageId}`), with `source` and `channel` columns used to scope queries.

**`ingestion/`** — source-specific adapters that translate external message formats into the DB schema:
- `TelegramAdapter.js` — converts Telegram Bot API message objects; called by both the poller and the HTTP ingest endpoints
- `TelegramPoller.js` — long-polls Telegram Bot API; persists the update offset in a `poller_state` table in the same DB
- `TelegramUserIngestor.js` — MTProto user-account approach using the `telegram` npm package; provides full message history including messages to/from other bots

**`server/index.js`** — Express API. The `buildTree(source, channel)` helper is the glue: it queries messages from DB and feeds them in timestamp order into a fresh `TreeNavigator`. The `PORTAL_VIEWER_USER_ID` env var sets whose perspective is "self" for branching/jumping logic; if unset, it defaults to the most frequent sender in that channel.

**`web/public/index.html`** — single-file web UI served as static files.

## Key Conventions

- Message IDs are source-prefixed strings: `tg:{chatId}:{messageId}`. Inserts are idempotent (`INSERT OR IGNORE`).
- `sender` in `TreeNavigator` is always `"self"` or `"other"` — the adapter/server maps source-specific user IDs to this binary before feeding messages into the navigator.
- The `data/` directory is gitignored. `data/dev.db` is used by `npm run dev` and seed scripts; `data/portal.db` is the production DB.
- Tests use Node's built-in `node:test` module — no test framework dependency.
- Adding a new ingestion source means: write an adapter in `ingestion/` that produces the normalized message shape (`id`, `source`, `channel`, `senderId`, `content`, `timestamp`, `replyToId`, etc.) and calls `db.insertMessage()`.
