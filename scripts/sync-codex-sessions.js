#!/usr/bin/env node
/**
 * sync-codex-sessions.js
 *
 * Ingests Codex Desktop session files into kp.
 *
 * Usage:
 *   CODEX_SOURCES=/path/to/codex-sync DB_PATH=/path/to/portal.db node scripts/sync-codex-sessions.js
 *
 * CODEX_SOURCES accepts colon-separated entries:
 *   /path/to/sync-root          directory with {hostname}/.codex or {hostname}/sessions mirrors
 *   hostname=/path/to/.codex    explicit hostname to Codex home path
 *   hostname=/path/to/sessions  explicit hostname to sessions path
 *
 * The local machine's ~/.codex/sessions is always included when present.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { CodexSessionIngestor } = require('../ingestion/CodexSessionIngestor');

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data/portal.db');
const CODEX_SOURCES = process.env.CODEX_SOURCES || '';

function getLocalHostname() {
  try {
    const status = JSON.parse(execSync('tailscale status --json', { timeout: 5000 }).toString());
    return status?.Self?.HostName || null;
  } catch {
    return process.env.HOSTNAME || execSync('hostname').toString().trim().split('.')[0];
  }
}

function sourceFromCodexPath(hostname, codexPath) {
  const stats = fs.existsSync(codexPath) ? fs.statSync(codexPath) : null;
  if (!stats || !stats.isDirectory()) return null;

  const sessionsRoot = path.basename(codexPath) === 'sessions'
    ? codexPath
    : path.join(codexPath, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;

  const codexHome = path.basename(codexPath) === 'sessions'
    ? path.dirname(codexPath)
    : codexPath;
  return {
    hostname,
    sessionsRoot,
    indexPath: path.join(codexHome, 'session_index.jsonl'),
  };
}

function collectSources() {
  const sources = [];

  for (const entry of CODEX_SOURCES.split(':').map(s => s.trim()).filter(Boolean)) {
    if (entry.includes('=/')) {
      const eqIdx = entry.indexOf('=');
      const source = sourceFromCodexPath(entry.slice(0, eqIdx), entry.slice(eqIdx + 1));
      if (source) sources.push(source);
    } else if (fs.existsSync(entry)) {
      const subdirs = fs.readdirSync(entry, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const hostname of subdirs) {
        const hostRoot = path.join(entry, hostname);
        const source = sourceFromCodexPath(hostname, path.join(hostRoot, '.codex'))
          || sourceFromCodexPath(hostname, hostRoot);
        if (source) sources.push(source);
      }
    }
  }

  const localCodexHome = path.join(process.env.HOME || '~', '.codex');
  const localSource = sourceFromCodexPath(getLocalHostname(), localCodexHome);
  if (localSource) sources.push(localSource);

  return sources;
}

async function main() {
  const sources = collectSources();
  if (sources.length === 0) {
    console.error('[Codex] No sources found. Set CODEX_SOURCES or ensure ~/.codex/sessions exists.');
    process.exit(1);
  }

  let totalMessages = 0;
  let totalSessions = 0;

  for (const { hostname, sessionsRoot, indexPath } of sources) {
    console.log(`[Codex] Ingesting from ${hostname}: ${sessionsRoot}`);
    const ingestor = new CodexSessionIngestor({ dbPath: DB_PATH, sessionsRoot, hostname, indexPath });
    const result = await ingestor.ingestAll();
    totalMessages += result.messages;
    totalSessions += result.sessions;
  }

  console.log(`[Codex] Done. Total sessions: ${totalSessions}, messages: ${totalMessages}`);
}

main().catch(err => {
  console.error('[Codex] Fatal error:', err);
  process.exit(1);
});
