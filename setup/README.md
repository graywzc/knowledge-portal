# Mac Mini Setup — Claude Code Session Ingestion

## Machines

| Machine | Tailscale hostname | Role |
|---|---|---|
| Mac Mini M4 | `mini4` | kp server, runs launchd ingest agent |
| MacBook Air | `mba` | Claude Code client, ingested remotely |

## Prerequisites

- **mini4**: running kp server, Node.js installed, Tailscale connected
- **mba** (and any other client): Remote Login enabled (System Settings → General → Sharing → Remote Login), Tailscale connected

No scripts or agents are needed on client machines.

## One-time setup on mini4

### 1. Verify SSH access to each client machine

```bash
ssh mba "ls ~/.claude/projects"
```

If this fails, check Remote Login is enabled on mba and both machines are on Tailscale.

### 2. Create the sources config

```bash
cp setup/kp-claude-sources.example ~/.kp-claude-sources
# Edit to list all remote machines (one Tailscale hostname per line)
```

mini4's own `~/.claude/projects/` is always included automatically — no entry needed for it.

### 3. Install the launchd agent

```bash
cp setup/mac-mini-ingest.plist ~/Library/LaunchAgents/com.kp.claude-ingest.plist
launchctl load ~/Library/LaunchAgents/com.kp.claude-ingest.plist
```

The agent runs every 10 minutes. It:
1. Reads `~/.kp-claude-sources` and rsyncs each listed machine's `~/.claude/projects/` → `~/claude-sync/{hostname}/`
2. Runs `sync-claude-sessions.js` which ingests all synced sessions plus mini4's own local sessions

### 4. Check logs

```bash
tail -f ~/Library/Logs/kp-claude-ingest.log
tail -f ~/Library/Logs/kp-claude-ingest.err
```

### 5. Manual sync

```bash
DB_PATH=data/portal.db CLAUDE_SOURCES=~/claude-sync npm run claude:sync
```

## Registering a new machine

1. Enable Remote Login on the new machine (System Settings → General → Sharing → Remote Login)
2. Confirm it's on Tailscale and reachable: `ssh <hostname> "echo ok"`
3. Add its Tailscale hostname to `~/.kp-claude-sources` on mini4:
   ```bash
   echo "new-hostname" >> ~/.kp-claude-sources
   ```
4. Reload the agent (or wait for the next 10-minute run):
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.kp.claude-ingest.plist
   launchctl load ~/Library/LaunchAgents/com.kp.claude-ingest.plist
   ```

## Behavior when a machine is offline or asleep

- rsync for that machine fails fast (30s timeout) and logs a skip message
- The ingest step always runs on whatever data was synced last time
- mini4's own sessions are always ingested fresh
- Next time the machine wakes up, rsync catches up automatically (ingest is idempotent)

## How sessions map to kp

Each `.jsonl` file = one Claude Code session = one kp topic.
Sessions are grouped by project in the sidebar. The topic name comes from the session's
custom title (if set) or first assistant `slug`.
Messages are flat (`branched=0`); use kp's manual reorganization to restructure if needed.
