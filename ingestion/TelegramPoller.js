/**
 * TelegramPoller — polls Telegram Bot API for updates and ingests messages.
 *
 * Standalone process, no dependency on OpenClaw.
 * Uses long-polling (getUpdates) to fetch new messages.
 * Tracks offset to avoid re-processing (Telegram-side dedup).
 * Messages are also idempotent on insert (DB-side dedup).
 */

const https = require('https');
const { Database } = require('../db/Database');
const { TelegramAdapter } = require('./TelegramAdapter');

class TelegramPoller {
  /**
   * @param {object} opts
   * @param {string} opts.token - Bot API token
   * @param {string} opts.dbPath - path to SQLite DB
   * @param {string} opts.chatId - chat id to filter (optional, ingests all if omitted)
   * @param {string} opts.selfUserId - bot's user id for sender_role detection
   * @param {number} opts.pollTimeout - long-poll timeout in seconds (default 30)
   * @param {number} opts.retryDelay - ms to wait on error before retrying (default 5000)
   */
  constructor(opts) {
    this.token = opts.token;
    this.chatId = opts.chatId ? String(opts.chatId) : null;
    this.pollTimeout = opts.pollTimeout || 30;
    this.retryDelay = opts.retryDelay || 5000;
    this.offset = 0;
    this.running = false;

    this.db = new Database(opts.dbPath);
    this.adapter = new TelegramAdapter(this.db, { selfUserId: opts.selfUserId });

    // Load saved offset if exists
    this._initOffsetStore();
  }

  _initOffsetStore() {
    this.db.db.exec(`
      CREATE TABLE IF NOT EXISTS poller_state (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    const row = this.db.db.prepare('SELECT value FROM poller_state WHERE key = ?').get('offset');
    if (row) this.offset = parseInt(row.value, 10) || 0;
  }

  _saveOffset() {
    this.db.db.prepare(
      'INSERT OR REPLACE INTO poller_state (key, value) VALUES (?, ?)'
    ).run('offset', String(this.offset));
  }

  /**
   * Make a Telegram Bot API call.
   */
  _apiCall(method, params = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(`https://api.telegram.org/bot${this.token}/${method}`);
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      });

      https.get(url.toString(), (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.ok) reject(new Error(`Telegram API error: ${parsed.description}`));
            else resolve(parsed.result);
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * Start polling loop.
   */
  async start() {
    this.running = true;
    console.log(`[TelegramPoller] Starting. Chat filter: ${this.chatId || 'all'}, offset: ${this.offset}`);

    // Verify bot identity
    try {
      const me = await this._apiCall('getMe');
      console.log(`[TelegramPoller] Bot: @${me.username} (id: ${me.id})`);
    } catch (e) {
      console.error(`[TelegramPoller] Failed to verify bot:`, e.message);
    }

    while (this.running) {
      try {
        const updates = await this._apiCall('getUpdates', {
          offset: this.offset,
          timeout: this.pollTimeout,
          allowed_updates: 'message',
        });

        if (updates.length > 0) {
          let ingested = 0;
          for (const update of updates) {
            if (update.message) {
              const msg = update.message;
              const chatId = String(msg.chat?.id || '');

              // Filter by chat if configured
              if (this.chatId && chatId !== this.chatId) continue;

              const result = this.adapter.ingest(msg);
              if (result) ingested++;
            }
            // Advance offset past this update
            this.offset = Math.max(this.offset, update.update_id + 1);
          }
          this._saveOffset();
          if (ingested > 0) {
            console.log(`[TelegramPoller] Ingested ${ingested} messages (offset: ${this.offset})`);
          }
        }
      } catch (e) {
        console.error(`[TelegramPoller] Error:`, e.message);
        await this._sleep(this.retryDelay);
      }
    }
  }

  stop() {
    this.running = false;
    console.log('[TelegramPoller] Stopping...');
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = { TelegramPoller };
