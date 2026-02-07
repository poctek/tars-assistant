# WhatsApp → Telegram Migration

## Decisions

- **Full replacement**, not multi-platform. Remove WhatsApp entirely.
- **No trigger pattern** — respond to all messages in registered chats.
- **Whitelist model** — only registered chats get responses, configured via JSON file.
- **Main channel** — DM with bot from owner (identified by `OWNER_TELEGRAM_ID`).
- **Library** — `grammy` (TypeScript-native, well-typed, active maintenance).
- **In-place replacement** — modify existing files, no abstraction layer.
- **Clean DB start** — drop old SQLite data, fresh schema.
- **Per-group model** — configurable model per chat (opus/sonnet/haiku).
- **Local Whisper** — `whisper.cpp` on CPU instead of OpenAI API for voice transcription.

## Files to Modify

| File | Change |
|------|--------|
| `src/index.ts` | Baileys → grammY. Long polling. Event-driven message capture → SQLite. Remove LID translation, group metadata sync, QR auth. Keep polling-based router for batching. |
| `src/db.ts` | `jid TEXT` → `chat_id INTEGER` in all tables. `id TEXT` → `id INTEGER` for messages. Remove Baileys proto import. Plain args in `storeMessage()`. |
| `src/types.ts` | `chatJid: string` → `chatId: number`. Add `model?: string` to `RegisteredGroup`. |
| `src/config.ts` | Remove `TRIGGER_PATTERN`. Add `DEFAULT_MODEL`. |
| `src/container-runner.ts` | `chatJid` → `chatId` in input JSON. Add `model` to input. |
| `container/agent-runner/src/ipc-mcp.ts` | `chatJid` → `chatId`. Update tool descriptions. Remove `register_group` tool. |
| `container/agent-runner/src/index.ts` | Read `model` from input, set `CLAUDE_MODEL` env. |
| `package.json` | Remove `@whiskeysockets/baileys`, `qrcode-terminal`. Add `grammy`. |

## Files to Delete

- `src/whatsapp-auth.ts`

## Telegram Connection

```
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN)
bot.start() // long polling
```

No QR code, no auth state files. Single env var.

**Receiving:** grammY event → check `chat.id` in registeredGroups → store in SQLite → router picks up via 2s polling loop (unchanged batching logic).

**Sending:** `bot.api.sendMessage(chatId, text)`

**Typing:** `bot.api.sendChatAction(chatId, 'typing')` — needs interval (Telegram resets after 5s).

**Voice:** `ctx.message.voice` → `bot.api.getFile(fileId)` → download .ogg → convert to wav → `whisper.cpp` CLI → text.

## Database Schema

```sql
CREATE TABLE chats (
  chat_id INTEGER PRIMARY KEY,
  name TEXT,
  last_message_time TEXT
);

CREATE TABLE messages (
  id INTEGER,
  chat_id INTEGER,
  sender INTEGER,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT,
  is_from_me INTEGER DEFAULT 0,
  PRIMARY KEY (id, chat_id),
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
);

CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  context_mode TEXT NOT NULL DEFAULT 'isolated',
  next_run TEXT,
  last_run TEXT,
  last_result TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  duration_ms INTEGER,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
);
```

## Config Format

`data/registered_groups.json`:
```json
{
  "main": {
    "chatId": 123456789,
    "name": "main",
    "folder": "main",
    "isMain": true,
    "model": "opus"
  },
  "family": {
    "chatId": -100987654321,
    "name": "family",
    "folder": "family-chat",
    "model": "haiku"
  }
}
```

## Environment Variables

**New:**
- `TELEGRAM_BOT_TOKEN` — required
- `OWNER_TELEGRAM_ID` — owner's Telegram user ID (for main channel detection)
- `DEFAULT_MODEL` — fallback model (default: `sonnet`)

**Removed:**
- `TRIGGER_PATTERN` concept removed entirely

**Unchanged:**
- `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`
- `ASSISTANT_NAME`, `CONTAINER_IMAGE`, `CONTAINER_TIMEOUT`, `TZ`, `LOG_LEVEL`

## Local Whisper

Replace OpenAI Whisper API with `whisper.cpp` CLI:
- Install via AUR: `whisper.cpp-git`
- Model: `base` (~140MB, ~2-4s/min on Ryzen 8845HS) or `small` (~460MB) for better accuracy
- Flow: download .ogg from Telegram → convert to wav (ffmpeg) → `whisper-cpp -m model.bin -f audio.wav --output-txt` → read text output
- Fallback: if whisper.cpp not found, log warning and skip transcription

## IPC Changes

Only field renames:
- `chatJid` → `chatId` in all IPC JSON files
- Remove `register_group` action type
- Everything else unchanged (filesystem protocol, per-group namespaces, error handling)

## What Does NOT Change

- Container system (Docker/Apple Container lifecycle, mounts, isolation)
- IPC filesystem protocol
- Task scheduler logic
- Group folder structure (`groups/{name}/CLAUDE.md`)
- Agent runner (Claude SDK, tools, session management)
- Security model (mount allowlist, env filtering, per-group isolation)
