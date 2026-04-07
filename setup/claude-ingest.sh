#!/bin/bash
set -euo pipefail

KP_DIR=/opt/knowledge-portal/current
SYNC_ROOT=/Users/graywzc/claude-sync
SOURCES_FILE="${HOME}/.kp-claude-sources"

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
