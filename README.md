# Knowledge Portal

Tree-structured knowledge portal over flat chat conversations.

## Architecture

```
core/           — Pure logic (no UI/persistence deps). Consumable by any client.
  TreeNavigator.js   — Tree navigation engine + pluggable strategy
server/         — Express API server
web/public/     — Web UI (one of potentially many UIs)
```

## Navigation Rules (Default Strategy)

| Action | Effect |
|---|---|
| Send without reply | Append to current layer |
| Reply to other's message | Branch into new sub-layer |
| Reply to own message | Jump back to that layer, append |

Navigation strategy is pluggable — swap `DefaultNavigationStrategy` with your own.

## Quick Start

```bash
npm install
npm run dev     # starts with --watch
```

Open http://localhost:3000

## API

- `POST /api/messages` — add a message `{ id, sender, replyToId?, content, timestamp? }`
- `GET /api/layers/:id` — get layer by id
- `GET /api/tree` — get full tree structure
- `GET /api/current` — get current layer
- `GET /api/state` — export state
- `POST /api/state` — import state
- `POST /api/reset` — reset to empty

## Test

```bash
npm test
```
