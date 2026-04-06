#!/bin/bash
set -euo pipefail

KP_DIR=/Users/graywzc/projects/knowledge-portal
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
  done < "${SOURCES_FILE}"
fi

# Ingest all sources (local machine always included by sync-claude-sessions.js)
CLAUDE_SOURCES="${SYNC_ROOT}" \
  DB_PATH=/Users/graywzc/projects/knowledge-portal/data/portal.db \
  /opt/homebrew/bin/node "${KP_DIR}/scripts/sync-claude-sessions.js"
