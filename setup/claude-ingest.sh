#!/bin/bash
set -euo pipefail

KP_DIR=/opt/knowledge-portal/current
SYNC_ROOT=/Users/graywzc/claude-sync
CODEX_SYNC_ROOT=/Users/graywzc/codex-sync
SOURCES_FILE="${HOME}/.kp-claude-sources"
CODEX_SOURCES_FILE="${HOME}/.kp-codex-sources"

# Rsync each registered remote machine (best-effort — offline is fine)
if [ -f "${SOURCES_FILE}" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blank lines and comments
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^# ]] && continue
    HOSTNAME="$line"
    DEST="${SYNC_ROOT}/${HOSTNAME}"
    mkdir -p "${DEST}"
    rsync -a --delete --timeout=30 "${HOSTNAME}:~/.claude/projects/" "${DEST}/" \
      || echo "[kp-ingest] rsync skipped for ${HOSTNAME} (offline or unreachable)"
    rsync -a --delete --timeout=30 "${HOSTNAME}:~/.claude/image-cache/" "${SYNC_ROOT}/${HOSTNAME}-image-cache/" \
      || echo "[kp-ingest] image-cache rsync skipped for ${HOSTNAME} (offline or unreachable)"
  done < "${SOURCES_FILE}"
fi

# Rsync Codex Desktop sessions from registered remote machines.
# If no Codex-specific source file exists, reuse the Claude source list so the
# same client hostnames are ingested for both agents.
CODEX_REMOTE_SOURCES_FILE="${CODEX_SOURCES_FILE}"
if [ ! -f "${CODEX_REMOTE_SOURCES_FILE}" ]; then
  CODEX_REMOTE_SOURCES_FILE="${SOURCES_FILE}"
fi

if [ -f "${CODEX_REMOTE_SOURCES_FILE}" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^# ]] && continue
    HOSTNAME="$line"
    DEST="${CODEX_SYNC_ROOT}/${HOSTNAME}/.codex"
    mkdir -p "${DEST}/sessions"
    rsync -a --delete --timeout=30 "${HOSTNAME}:~/.codex/sessions/" "${DEST}/sessions/" \
      || echo "[kp-ingest] codex sessions rsync skipped for ${HOSTNAME} (offline, unreachable, or no Codex sessions)"
    rsync -a --timeout=30 "${HOSTNAME}:~/.codex/session_index.jsonl" "${DEST}/session_index.jsonl" \
      || echo "[kp-ingest] codex session_index rsync skipped for ${HOSTNAME} (offline, unreachable, or missing index)"
  done < "${CODEX_REMOTE_SOURCES_FILE}"
fi

# Load shared env for DB_PATH if available
SHARED_ENV=/opt/knowledge-portal/shared/.env
if [ -f "${SHARED_ENV}" ]; then
  set -a; source "${SHARED_ENV}"; set +a
fi

# Ingest all sources (local machine always included by sync-claude-sessions.js)
CLAUDE_SOURCES="${SYNC_ROOT}" \
  DB_PATH="${DB_PATH:-/Users/graywzc/projects/knowledge-portal/data/portal.db}" \
  MEDIA_ROOT="${KP_DIR}/media" \
  /opt/homebrew/bin/node "${KP_DIR}/scripts/sync-claude-sessions.js"

# Ingest Codex sessions (local machine always included by sync-codex-sessions.js)
CODEX_SOURCES="${CODEX_SYNC_ROOT}" \
  DB_PATH="${DB_PATH:-/Users/graywzc/projects/knowledge-portal/data/portal.db}" \
  /opt/homebrew/bin/node "${KP_DIR}/scripts/sync-codex-sessions.js"
