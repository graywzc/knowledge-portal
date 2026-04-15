const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Database } = require('../db/Database');

/**
 * Parses Codex Desktop JSONL session files and upserts messages into kp.
 *
 * Session files live at: {codexHome}/sessions/YYYY/MM/DD/rollout-...-{sessionId}.jsonl
 * Thread names are read from {codexHome}/session_index.jsonl when available.
 */

class CodexSessionIngestor {
  /**
   * @param {object} opts
   * @param {string} opts.dbPath       - path to kp SQLite database
   * @param {string} opts.sessionsRoot - path to ~/.codex/sessions (or rsync mirror)
   * @param {string} opts.hostname     - Tailscale hostname of the source machine
   * @param {string} [opts.indexPath]  - path to session_index.jsonl
   */
  constructor(opts) {
    this.db = new Database(opts.dbPath);
    this.sessionsRoot = opts.sessionsRoot;
    this.hostname = opts.hostname;
    this.indexPath = opts.indexPath || path.join(path.dirname(this.sessionsRoot), 'session_index.jsonl');
    this.sessionIndex = this.#readSessionIndex(this.indexPath);
  }

  /** Ingest all Codex rollout JSONL sessions under sessionsRoot. */
  async ingestAll() {
    const sessionFiles = this.#findSessionFiles(this.sessionsRoot);
    let totalMessages = 0;
    let totalSessions = 0;

    for (const filePath of sessionFiles) {
      const sessionId = this.#sessionIdFromPath(filePath);
      if (!sessionId) continue;

      const stat = fs.statSync(filePath);
      const relPath = path.relative(this.sessionsRoot, filePath);
      const stateKey = `codex:${this.hostname}:${relPath}`;
      const stored = this.db.getFileState(stateKey);
      if (stored && stored.file_mtime === Math.floor(stat.mtimeMs) && stored.file_size === stat.size) {
        continue;
      }

      const count = await this.ingestSession({ sessionId, filePath });
      this.db.setFileState(stateKey, Math.floor(stat.mtimeMs), stat.size);
      totalMessages += count;
      totalSessions++;
    }

    console.log(`[Codex] Ingest complete. Sessions: ${totalSessions}, Messages: ${totalMessages}`);
    return { sessions: totalSessions, messages: totalMessages };
  }

  /** Ingest a single Codex session file. */
  async ingestSession({ sessionId, filePath }) {
    const records = await this.#readJsonl(filePath);
    const sessionMeta = records.find(r => r.type === 'session_meta')?.payload || {};
    const turnContexts = records.filter(r => r.type === 'turn_context').map(r => r.payload || {});
    const firstTurnContext = turnContexts[0] || {};
    const lastTurnContext = turnContexts[turnContexts.length - 1] || {};
    const cwd = sessionMeta.cwd || firstTurnContext.cwd || lastTurnContext.cwd || null;
    const encodedProject = this.#encodeProject(cwd || 'unknown-project');
    const model = lastTurnContext.model || firstTurnContext.model || sessionMeta.model || null;
    const events = this.#extractEvents(records, { sessionId, encodedProject });

    if (events.length === 0) return 0;

    const firstUser = events.find(e => e.senderRole === 'self')?.content || '';
    const topicName = this.sessionIndex.get(sessionId)?.thread_name
      || this.#firstLine(firstUser)
      || `Session ${sessionId.slice(0, 8)}`;
    const firstEvent = events[0];
    const topicId = this.#messageId(encodedProject, sessionId, firstEvent.eventId);

    this.db.upsertTopic({
      id: topicId,
      source: 'codex',
      name: topicName,
      parentTopicId: null,
      meta: JSON.stringify({
        source: 'codex',
        hostname: this.hostname,
        encoded_project: encodedProject,
        session_id: sessionId,
        cwd,
        git_branch: lastTurnContext.gitBranch || lastTurnContext.git_branch || null,
        originator: sessionMeta.originator || null,
        cli_version: sessionMeta.cli_version || null,
        model,
      }),
    });

    let previousId = null;
    let count = 0;
    for (const event of events) {
      const id = this.#messageId(encodedProject, sessionId, event.eventId);
      this.db.insertMessage({
        id,
        source: 'codex',
        channel: encodedProject,
        topicId: sessionId,
        senderId: event.senderId,
        senderName: event.senderName,
        senderRole: event.senderRole,
        parentId: previousId,
        branched: 0,
        content: event.content,
        contentType: 'text',
        timestamp: event.timestamp,
        meta: JSON.stringify({
          hostname: this.hostname,
          encoded_project: encodedProject,
          session_id: sessionId,
          event_id: event.eventId,
          record_type: event.recordType,
          payload_type: event.payloadType || null,
          call_id: event.callId || null,
          model,
          chat_content: event.chatContent ?? undefined,
        }),
      });
      previousId = id;
      count++;
    }

    this.db.touchTopicTimestamp(topicId, sessionId, 'codex');
    return count;
  }

  #extractEvents(records, { sessionId }) {
    const events = [];
    records.forEach((record, index) => {
      const payload = record.payload || {};
      const timestamp = this.#parseTimestamp(record.timestamp || payload.timestamp);

      if (record.type === 'event_msg' && payload.type === 'user_message') {
        const content = this.#normalizeText(payload.message)
          || this.#textElementsToText(payload.text_elements)
          || '[user message]';
        events.push({
          eventId: `${index}:user_message`,
          recordType: record.type,
          payloadType: payload.type,
          senderId: 'user',
          senderName: 'Me',
          senderRole: 'self',
          content,
          chatContent: content,
          timestamp,
        });
      } else if (record.type === 'event_msg' && payload.type === 'agent_message') {
        const content = this.#normalizeText(payload.message);
        if (!content) return;
        events.push({
          eventId: `${index}:agent_message`,
          recordType: record.type,
          payloadType: payload.type,
          senderId: 'codex-ai',
          senderName: 'Codex',
          senderRole: 'bot',
          content,
          chatContent: content,
          timestamp,
        });
      } else if (record.type === 'response_item' && payload.type === 'function_call') {
        events.push({
          eventId: `${index}:function_call:${payload.call_id || ''}`,
          recordType: record.type,
          payloadType: payload.type,
          callId: payload.call_id || null,
          senderId: 'codex-ai',
          senderName: 'Codex',
          senderRole: 'bot',
          content: this.#formatToolCall(payload),
          timestamp,
        });
      } else if (record.type === 'response_item' && payload.type === 'function_call_output') {
        const content = this.#formatToolOutput(payload, sessionId);
        if (!content) return;
        events.push({
          eventId: `${index}:function_call_output:${payload.call_id || ''}`,
          recordType: record.type,
          payloadType: payload.type,
          callId: payload.call_id || null,
          senderId: 'codex-tool',
          senderName: 'Tool',
          senderRole: 'bot',
          content,
          timestamp,
        });
      }
    });
    return events;
  }

  #messageId(encodedProject, sessionId, eventId) {
    return Database.codexMessageId(this.hostname, encodedProject, sessionId, eventId);
  }

  #findSessionFiles(root) {
    if (!fs.existsSync(root)) return [];
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(fullPath);
      }
    };
    walk(root);
    return out.sort();
  }

  #sessionIdFromPath(filePath) {
    const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    return match ? match[1] : null;
  }

  #readSessionIndex(indexPath) {
    const out = new Map();
    if (!indexPath || !fs.existsSync(indexPath)) return out;
    const lines = fs.readFileSync(indexPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed);
        if (record.id) out.set(String(record.id), record);
      } catch {}
    }
    return out;
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
        } catch {}
      });
      rl.on('close', () => resolve(records));
      rl.on('error', reject);
    });
  }

  #parseTimestamp(ts) {
    if (!ts) return Date.now();
    const parsed = new Date(ts).getTime();
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  #encodeProject(cwd) {
    return String(cwd || 'unknown-project').replace(/[/\\]/g, '-');
  }

  #normalizeText(value) {
    if (typeof value !== 'string') return '';
    return value.trim();
  }

  #textElementsToText(elements) {
    if (!Array.isArray(elements)) return '';
    return elements
      .map(e => typeof e === 'string' ? e : (e?.text || e?.input_text || ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  #firstLine(text) {
    const line = String(text || '').trim().split(/\r?\n/).find(Boolean) || '';
    return line.length > 80 ? `${line.slice(0, 80)}...` : line;
  }

  #formatToolCall(payload) {
    const name = payload.name || 'tool';
    const args = this.#formatArguments(payload.arguments);
    return `[tool: ${name}]${args ? `\n${args}` : ''}`;
  }

  #formatToolOutput(payload, sessionId) {
    const output = this.#normalizeText(payload.output);
    if (!output) return null;
    return `[tool_result${payload.call_id ? `: ${payload.call_id}` : ''}]\n${this.#truncate(output, 2000)}`;
  }

  #formatArguments(args) {
    if (!args) return '';
    if (typeof args !== 'string') return this.#truncate(JSON.stringify(args), 2000);
    try {
      const parsed = JSON.parse(args);
      return this.#truncate(JSON.stringify(parsed, null, 2), 2000);
    } catch {
      return this.#truncate(args, 2000);
    }
  }

  #truncate(text, maxLen) {
    const value = String(text || '').trim();
    return value.length > maxLen ? `${value.slice(0, maxLen)}\n...(truncated)` : value;
  }
}

module.exports = { CodexSessionIngestor };
