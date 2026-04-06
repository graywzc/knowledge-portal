const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Database, uuidv5, KP_NAMESPACE } = require('../db/Database');

/**
 * Parses Claude Code JSONL session files and upserts messages into kp.
 *
 * Session files live at: {projectsRoot}/{encodedPath}/{sessionId}.jsonl
 * encodedPath  = cwd with slashes replaced by hyphens (e.g. -Users-larry-projects-kp)
 * sessionId    = UUID (filename without .jsonl)
 *
 * Each line is a JSON record with fields:
 *   type          "user" | "assistant" | "summary" | ...
 *   uuid          message UUID
 *   parentUuid    parent UUID or null (builds the reply chain)
 *   timestamp     ISO 8601
 *   message       string (user) or object (assistant)
 *   cwd           working directory at session start
 *   gitBranch     git branch (optional)
 *   slug          short title on first assistant record
 *   isSidechain   boolean — skip if true
 *   sessionId     UUID (same as filename)
 */

const INCLUDE_TYPES = new Set(['user', 'assistant']);

class ClaudeCodeIngestor {
  /**
   * @param {object} opts
   * @param {string} opts.dbPath           - path to kp SQLite database
   * @param {string} opts.projectsRoot     - path to ~/.claude/projects (or rsync mirror)
   * @param {string} opts.hostname         - Tailscale hostname of the source machine
   */
  constructor(opts) {
    this.db = new Database(opts.dbPath);
    this.projectsRoot = opts.projectsRoot;
    this.hostname = opts.hostname;
  }

  /** Ingest all sessions under projectsRoot */
  async ingestAll() {
    const projectDirs = fs.readdirSync(this.projectsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    let totalMessages = 0;
    let totalSessions = 0;

    for (const encodedProject of projectDirs) {
      const projectPath = path.join(this.projectsRoot, encodedProject);
      const sessionFiles = fs.readdirSync(projectPath)
        .filter(f => f.endsWith('.jsonl'));

      for (const filename of sessionFiles) {
        const sessionId = filename.replace(/\.jsonl$/, '');
        const filePath = path.join(projectPath, filename);
        const count = await this.ingestSession({ encodedProject, sessionId, filePath });
        totalMessages += count;
        totalSessions++;
      }
    }

    console.log(`[Claude] Ingest complete. Sessions: ${totalSessions}, Messages: ${totalMessages}`);
    return { sessions: totalSessions, messages: totalMessages };
  }

  /** Ingest a single session file */
  async ingestSession({ encodedProject, sessionId, filePath }) {
    const records = await this.#readJsonl(filePath);
    const included = records.filter(r => INCLUDE_TYPES.has(r.type) && !r.isSidechain);

    if (included.length === 0) return 0;

    // Title: prefer explicit custom-title record, fall back to first assistant slug
    const customTitleRecord = records.find(r => r.type === 'custom-title' && r.customTitle);
    const firstAssistant = included.find(r => r.type === 'assistant');
    const topicName = customTitleRecord?.customTitle
      || firstAssistant?.slug
      || null;

    // Derive topic id = uuid of the first record (root message of session)
    const firstRecord = included[0];
    const topicId = this.#messageId(encodedProject, sessionId, firstRecord.uuid);

    this.db.upsertTopic({
      id: topicId,
      name: topicName || `Session ${sessionId.slice(0, 8)}`,
      parentTopicId: null,
      meta: JSON.stringify({
        source: 'claude',
        hostname: this.hostname,
        encoded_project: encodedProject,
        session_id: sessionId,
        cwd: firstRecord.cwd || null,
        git_branch: firstRecord.gitBranch || null,
      }),
    });

    let count = 0;
    for (const record of included) {
      const id = this.#messageId(encodedProject, sessionId, record.uuid);
      const parentId = record.parentUuid
        ? this.#messageId(encodedProject, sessionId, record.parentUuid)
        : null;

      const extracted = this.#extractContent(record);
      if (!extracted) continue; // tool-result-only turn — nothing to store
      const { content, contentType } = extracted;
      const timestamp = this.#parseTimestamp(record.timestamp);

      this.db.insertMessage({
        id,
        source: 'claude',
        channel: `${this.hostname}:${encodedProject}`,
        topicId: sessionId,
        senderId: record.type === 'user' ? 'user' : 'claude-ai',
        senderName: record.type === 'user' ? 'Me' : 'Claude',
        senderRole: record.type === 'user' ? 'self' : 'bot',
        parentId,
        branched: 0,  // Claude sessions are always flat
        content,
        contentType,
        timestamp,
        meta: JSON.stringify({
          hostname: this.hostname,
          encoded_project: encodedProject,
          session_id: sessionId,
          uuid: record.uuid,
          parent_uuid: record.parentUuid || null,
          cwd: record.cwd || null,
          git_branch: record.gitBranch || null,
          model: record.message?.model || null,
        }),
      });
      count++;
    }

    // Stamp topic updated_at with the actual max message timestamp from DB,
    // so sessions are ordered by real activity rather than sync time.
    this.db.touchTopicTimestamp(topicId, sessionId);

    return count;
  }

  #messageId(encodedProject, sessionId, messageUuid) {
    return Database.claudeMessageId(this.hostname, encodedProject, sessionId, messageUuid);
  }

  #parseTimestamp(ts) {
    if (!ts) return Date.now();
    const parsed = new Date(ts).getTime();
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  #extractContent(record) {
    const msg = record.message;

    if (record.type === 'user') {
      if (typeof msg === 'string') return { content: msg, contentType: 'text' };
      if (typeof msg === 'object' && msg !== null) {
        // May be { role, content: string|array }
        const inner = msg.content;
        if (typeof inner === 'string') return { content: inner, contentType: 'text' };
        if (Array.isArray(inner)) {
          const parts = inner
            .filter(p => p.type !== 'tool_result')
            .map(p => (p.type === 'text' ? p.text || '' : ''))
            .filter(Boolean);
          if (parts.length === 0) return null; // tool-result-only turn, skip
          return { content: parts.join('\n'), contentType: 'text' };
        }
      }
      return { content: '[user message]', contentType: 'text' };
    }

    if (record.type === 'assistant') {
      if (typeof msg === 'object' && msg !== null) {
        const inner = msg.content;
        if (Array.isArray(inner)) {
          const parts = [];
          for (const block of inner) {
            if (block.type === 'text' && block.text) {
              parts.push(block.text);
            } else if (block.type === 'tool_use' && block.name) {
              parts.push(`[tool: ${block.name}]`);
            }
          }
          return { content: parts.join('\n') || '[assistant message]', contentType: 'text' };
        }
        if (typeof inner === 'string') return { content: inner, contentType: 'text' };
      }
      if (typeof msg === 'string') return { content: msg, contentType: 'text' };
      return { content: '[assistant message]', contentType: 'text' };
    }

    return { content: '[message]', contentType: 'text' };
  }

  #readJsonl(filePath) {
    return new Promise((resolve, reject) => {
      const records = [];
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      rl.on('line', line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          records.push(JSON.parse(trimmed));
        } catch {
          // skip malformed lines
        }
      });
      rl.on('close', () => resolve(records));
      rl.on('error', reject);
    });
  }
}

module.exports = { ClaudeCodeIngestor };
