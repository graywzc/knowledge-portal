# Mac Mini Setup — Code Agent Session Ingestion

## Machines

| Machine | Tailscale hostname | Role |
|---|---|---|
| Mac Mini M4 | `mini4` | kp server, runs launchd ingest agent |
| MacBook Air | `mba` | Claude Code and Codex client, ingested remotely |

## Prerequisites

- **mini4**: running kp server, Node.js installed, Tailscale connected
- **mba** (and any other client): Remote Login enabled (System Settings → General → Sharing → Remote Login), Tailscale connected

No scripts or agents are needed on client machines.

## One-time setup on mini4

### 1. Verify SSH access to each client machine

```bash
ssh mba "ls ~/.claude/projects"
ssh mba "ls ~/.codex/sessions"
```

If this fails, check Remote Login is enabled on mba and both machines are on Tailscale.

### 2. Create the sources config

```bash
cp setup/kp-claude-sources.example ~/.kp-claude-sources
# Edit to list all remote machines (one Tailscale hostname per line)
```

By default, Codex ingestion reuses `~/.kp-claude-sources`. If you need a different
remote host list for Codex, create a Codex-specific file:

```bash
cp setup/kp-codex-sources.example ~/.kp-codex-sources
```

mini4's own `~/.claude/projects/` and `~/.codex/sessions/` are always included automatically — no entry needed for it.

### 3. Install the launchd agent

```bash
cp setup/mac-mini-ingest.plist ~/Library/LaunchAgents/com.kp.claude-ingest.plist
launchctl load ~/Library/LaunchAgents/com.kp.claude-ingest.plist
```

The agent runs every 10 minutes. It:
1. Reads `~/.kp-claude-sources` and rsyncs each listed machine's `~/.claude/projects/` → `~/claude-sync/{hostname}/`
2. Reads `~/.kp-codex-sources` if present, otherwise `~/.kp-claude-sources`, and rsyncs each listed machine's `~/.codex/sessions/` plus `~/.codex/session_index.jsonl` → `~/codex-sync/{hostname}/.codex/`
3. Runs `sync-claude-sessions.js` and `sync-codex-sessions.js`, which ingest all synced sessions plus mini4's own local sessions

### 4. Check logs

```bash
tail -f ~/Library/Logs/kp-claude-ingest.log
tail -f ~/Library/Logs/kp-claude-ingest.err
```

### 5. Manual sync

```bash
DB_PATH=data/portal.db CLAUDE_SOURCES=~/claude-sync npm run claude:sync
DB_PATH=data/portal.db CODEX_SOURCES=~/codex-sync npm run codex:sync
```

## Registering a new machine

1. Enable Remote Login on the new machine (System Settings → General → Sharing → Remote Login)
2. Confirm it's on Tailscale and reachable: `ssh <hostname> "echo ok"`
3. Add its Tailscale hostname to `~/.kp-claude-sources` on mini4:
   ```bash
   echo "new-hostname" >> ~/.kp-claude-sources
   ```
   If you created `~/.kp-codex-sources`, add it there too.
4. Reload the agent (or wait for the next 10-minute run):
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.kp.claude-ingest.plist
   launchctl load ~/Library/LaunchAgents/com.kp.claude-ingest.plist
   ```

## Behavior when a machine is offline or asleep

- rsync for that machine fails fast (30s timeout) and logs a skip message
- The ingest step always runs on whatever data was synced last time
- mini4's own Claude and Codex sessions are always ingested fresh
- Next time the machine wakes up, rsync catches up automatically (ingest is idempotent)

## How sessions map to kp

Each `.jsonl` file = one Claude Code session = one kp topic.
Sessions are grouped by project in the sidebar. The topic name comes from the session's
custom title (if set) or first assistant `slug`.
Messages are flat (`branched=0`); use kp's manual reorganization to restructure if needed.

Each Codex rollout `.jsonl` file = one Codex session = one kp topic.
Sessions are grouped by the recorded `cwd`. The topic name comes from
`~/.codex/session_index.jsonl` when available, otherwise the first user message.
Codex user turns, assistant messages, tool calls, and tool outputs are stored as a flat timeline.
