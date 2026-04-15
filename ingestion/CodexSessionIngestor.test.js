const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../db/Database');
const { CodexSessionIngestor } = require('./CodexSessionIngestor');

describe('CodexSessionIngestor', () => {
  let dir;
  let dbPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-codex-ingest-'));
    dbPath = path.join(dir, 'portal.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ingests Codex session events into code-agent topics and messages', async () => {
    const codexHome = path.join(dir, '.codex');
    const sessionsRoot = path.join(codexHome, 'sessions');
    const dayDir = path.join(sessionsRoot, '2026', '04', '15');
    fs.mkdirSync(dayDir, { recursive: true });

    const sessionId = '019d91ec-a3dc-7cd3-827a-24df0d7a655b';
    fs.writeFileSync(
      path.join(codexHome, 'session_index.jsonl'),
      JSON.stringify({ id: sessionId, thread_name: 'Add Codex session ingestion', updated_at: '2026-04-15T16:15:29.033736Z' }) + '\n',
    );
    fs.writeFileSync(
      path.join(dayDir, `rollout-2026-04-15T09-14-58-${sessionId}.jsonl`),
      [
        {
          timestamp: '2026-04-15T16:15:25.563Z',
          type: 'session_meta',
          payload: {
            id: sessionId,
            cwd: '/Users/graywzc/projects/knowledge-portal',
            originator: 'Codex Desktop',
            cli_version: '0.119.0-alpha.28',
          },
        },
        {
          timestamp: '2026-04-15T16:15:25.564Z',
          type: 'turn_context',
          payload: {
            cwd: '/Users/graywzc/projects/knowledge-portal',
            model: 'gpt-5.4',
          },
        },
        {
          timestamp: '2026-04-15T16:15:25.565Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Please ingest Codex sessions.' },
        },
        {
          timestamp: '2026-04-15T16:15:30.930Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'I will inspect the Codex session format.' },
        },
        {
          timestamp: '2026-04-15T16:15:30.937Z',
          type: 'response_item',
          payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls ~/.codex/sessions"}', call_id: 'call_1' },
        },
        {
          timestamp: '2026-04-15T16:15:31.017Z',
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call_1', output: '2026' },
        },
      ].map(r => JSON.stringify(r)).join('\n') + '\n',
    );

    const ingestor = new CodexSessionIngestor({ dbPath, sessionsRoot, hostname: 'mini4' });
    await expect(ingestor.ingestAll()).resolves.toEqual({ sessions: 1, messages: 4 });

    const db = new Database(dbPath);
    const topics = db.getCodexTopics({ limit: 10 });
    expect(topics).toHaveLength(1);
    expect(topics[0]).toEqual(expect.objectContaining({
      source: 'codex',
      name: 'Add Codex session ingestion',
      sessionId,
      hostname: 'mini4',
      encodedProject: '-Users-graywzc-projects-knowledge-portal',
      projectName: 'knowledge-portal',
      messageCount: 4,
    }));

    const projects = db.getCodexProjects();
    expect(projects).toEqual([
      expect.objectContaining({
        key: 'mini4:-Users-graywzc-projects-knowledge-portal',
        sessionCount: 1,
        projectName: 'knowledge-portal',
      }),
    ]);

    const messages = db.getMessages('codex', sessionId);
    expect(messages.map(m => m.sender_role)).toEqual(['self', 'bot', 'bot', 'bot']);
    expect(messages.map(m => m.content)).toEqual([
      'Please ingest Codex sessions.',
      'I will inspect the Codex session format.',
      '[tool: exec_command]\n{\n  "cmd": "ls ~/.codex/sessions"\n}',
      '[tool_result: call_1]\n2026',
    ]);

    const resolved = db.resolveTopicScopeByUUID(topics[0].topicUUID);
    expect(resolved).toEqual(expect.objectContaining({
      source: 'codex',
      locator: expect.objectContaining({ channel: sessionId, sessionId }),
    }));
    db.close();
  });
});
