#!/usr/bin/env node
/**
 * sync-claude-sessions.js
 *
 * Ingests Claude Code session files into kp.
 *
 * Usage:
 *   CLAUDE_SOURCES=/path/to/claude-sync DB_PATH=/path/to/portal.db node scripts/sync-claude-sessions.js
 *
 * CLAUDE_SOURCES points to a directory where each subdirectory is named after a
 * Tailscale hostname (e.g. larry-mbp/) and contains a mirror of ~/.claude/projects/
 * from that machine.
 *
 * For the local machine (Mac Mini), sessions live directly in ~/.claude/projects/.
 * The local hostname is read from the HOSTNAME env var or `hostname` command output.
 *
 * Multiple source directories can be provided as a colon-separated list in CLAUDE_SOURCES.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ClaudeCodeIngestor } = require('../ingestion/ClaudeCodeIngestor');

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data/portal.db');
const CLAUDE_SOURCES = process.env.CLAUDE_SOURCES || '';

function getLocalHostname() {
  try {
    const status = JSON.parse(execSync('tailscale status --json', { timeout: 5000 }).toString());
    return status?.Self?.HostName || null;
  } catch {
    return process.env.HOSTNAME || execSync('hostname').toString().trim().split('.')[0];
  }
}

async function main() {
  const sources = [];

  // Each entry in CLAUDE_SOURCES is either:
  //   /path/to/sync-root  (directory with {hostname}/ subdirs, one per machine)
  //   hostname:/path/to/projects  (explicit hostname:path pair)
  for (const entry of CLAUDE_SOURCES.split(':').map(s => s.trim()).filter(Boolean)) {
    if (entry.includes('=/')) {
      // hostname=/path format
      const eqIdx = entry.indexOf('=');
      sources.push({ hostname: entry.slice(0, eqIdx), projectsRoot: entry.slice(eqIdx + 1) });
    } else if (fs.existsSync(entry)) {
      // Treat as sync root: enumerate {hostname}/ subdirs
      const subdirs = fs.readdirSync(entry, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const hostname of subdirs) {
        sources.push({ hostname, projectsRoot: path.join(entry, hostname) });
      }
    }
  }

  // Always include the local machine's ~/.claude/projects
  const localProjectsRoot = path.join(process.env.HOME || '~', '.claude', 'projects');
  if (fs.existsSync(localProjectsRoot)) {
    const localHostname = getLocalHostname();
    sources.push({ hostname: localHostname, projectsRoot: localProjectsRoot });
  }

  if (sources.length === 0) {
    console.error('[Claude] No sources found. Set CLAUDE_SOURCES or ensure ~/.claude/projects exists.');
    process.exit(1);
  }

  let totalMessages = 0;
  let totalSessions = 0;

  for (const { hostname, projectsRoot } of sources) {
    console.log(`[Claude] Ingesting from ${hostname}: ${projectsRoot}`);
    const ingestor = new ClaudeCodeIngestor({ dbPath: DB_PATH, projectsRoot, hostname });
    const result = await ingestor.ingestAll();
    totalMessages += result.messages;
    totalSessions += result.sessions;
  }

  console.log(`[Claude] Done. Total sessions: ${totalSessions}, messages: ${totalMessages}`);
}

main().catch(err => {
  console.error('[Claude] Fatal error:', err);
  process.exit(1);
});
