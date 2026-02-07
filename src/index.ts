import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { Bot } from 'grammy';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_MODEL,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  OWNER_TELEGRAM_ID,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  initDatabase,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { NewMessage, RegisteredGroup, Session } from './types.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';

let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let ipcWatcherRunning = false;

let bot: Bot;

const TYPING_INTERVAL = 5000;

function chatIdToKey(chatId: number): string {
  return String(chatId);
}

function findGroupByChatId(chatId: number): RegisteredGroup | undefined {
  return Object.values(registeredGroups).find((g) => g.chatId === chatId);
}

async function setTyping(chatId: number, active: boolean): Promise<() => void> {
  if (!active) return () => {};
  try {
    await bot.api.sendChatAction(chatId, 'typing');
  } catch (err) {
    logger.debug({ chatId, err }, 'Failed to send typing action');
  }
  const interval = setInterval(async () => {
    try {
      await bot.api.sendChatAction(chatId, 'typing');
    } catch {
      // ignore
    }
  }, TYPING_INTERVAL);
  return () => clearInterval(interval);
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(
    path.join(DATA_DIR, 'registered_groups.json'),
    {},
  );
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), {
    last_timestamp: lastTimestamp,
    last_agent_timestamp: lastAgentTimestamp,
  });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

async function transcribeVoice(fileId: string): Promise<string | null> {
  let oggPath: string | null = null;
  let wavPath: string | null = null;
  try {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) return null;

    const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
    const tmpDir = path.join(os.tmpdir(), 'nanoclaw-voice');
    fs.mkdirSync(tmpDir, { recursive: true });

    oggPath = path.join(tmpDir, `${fileId}.ogg`);
    wavPath = path.join(tmpDir, `${fileId}.wav`);

    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(oggPath, buffer);

    try {
      execSync(`ffmpeg -y -i "${oggPath}" -ar 16000 -ac 1 "${wavPath}" 2>/dev/null`, {
        timeout: 30000,
      });
    } catch {
      logger.warn('ffmpeg failed to convert voice message');
      return null;
    }

    let whisperBin = 'whisper-cpp';
    try {
      execSync(`which ${whisperBin}`, { stdio: 'pipe' });
    } catch {
      whisperBin = 'whisper';
      try {
        execSync(`which ${whisperBin}`, { stdio: 'pipe' });
      } catch {
        logger.warn('whisper.cpp not found, skipping transcription');
        return null;
      }
    }

    const modelPath = process.env.WHISPER_MODEL || '/usr/share/whisper.cpp/models/ggml-base.bin';
    try {
      execSync(
        `${whisperBin} -m "${modelPath}" -f "${wavPath}" --output-txt --output-file "${wavPath}" 2>/dev/null`,
        { timeout: 60000, encoding: 'utf-8' },
      );
      const txtPath = `${wavPath}.txt`;
      if (fs.existsSync(txtPath)) {
        const text = fs.readFileSync(txtPath, 'utf-8').trim();
        fs.unlinkSync(txtPath);
        return text || null;
      }
      return null;
    } catch (err) {
      logger.warn({ err }, 'whisper.cpp transcription failed');
      return null;
    }
  } catch (err) {
    logger.error({ err }, 'Voice transcription error');
    return null;
  } finally {
    if (oggPath) {
      try {
        fs.unlinkSync(oggPath);
      } catch {}
    }
    if (wavPath) {
      try {
        fs.unlinkSync(wavPath);
      } catch {}
    }
  }
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = findGroupByChatId(msg.chat_id);
  if (!group) return;

  const content = msg.content.trim();
  if (!content) return;

  const key = chatIdToKey(msg.chat_id);
  const sinceTimestamp = lastAgentTimestamp[key] || '';
  const missedMessages = getMessagesSince(
    msg.chat_id,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  const lines = missedMessages.map((m) => {
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing message',
  );

  const stopTyping = await setTyping(msg.chat_id, true);
  const response = await runAgent(group, prompt, msg.chat_id);
  stopTyping();

  if (response) {
    lastAgentTimestamp[key] = msg.timestamp;
    await sendMessage(msg.chat_id, `${ASSISTANT_NAME}: ${response}`);
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatId: number,
): Promise<string | null> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];
  const model = group.model || DEFAULT_MODEL;

  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatId,
      isMain,
      model,
    });

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return null;
    }

    return output.result;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return null;
  }
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  const MAX_LENGTH = 4096;
  try {
    if (text.length <= MAX_LENGTH) {
      await bot.api.sendMessage(chatId, text);
      logger.info({ chatId, length: text.length }, 'Message sent');
    } else {
      let remaining = text;
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, MAX_LENGTH);
        await bot.api.sendMessage(chatId, chunk);
        remaining = remaining.slice(MAX_LENGTH);
      }
      logger.info({ chatId, length: text.length, chunks: Math.ceil(text.length / MAX_LENGTH) }, 'Message sent in chunks');
    }
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send message');
  }
}

function startIpcWatcher(): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatId && data.text) {
                const targetGroup = findGroupByChatId(data.chatId);
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await sendMessage(
                    data.chatId,
                    `${ASSISTANT_NAME}: ${data.text}`,
                  );
                  logger.info(
                    { chatId: data.chatId, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatId: data.chatId, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatId?: number;
  },
  sourceGroup: string,
  isMain: boolean,
): Promise<void> {
  const {
    createTask,
    updateTask,
    deleteTask,
    getTaskById: getTask,
  } = await import('./db.js');
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.groupFolder
      ) {
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetGroup },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const targetGroupConfig = Object.values(registeredGroups).find(
          (g) => g.folder === targetGroup,
        );

        if (!targetGroupConfig) {
          logger.warn(
            { targetGroup },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetChatId = targetGroupConfig.chatId;
        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_id: targetChatId,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetGroup, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;
  logger.info('Message polling loop started');

  while (true) {
    try {
      const chatIds = Object.values(registeredGroups).map((g) => g.chatId);
      const { messages } = getNewMessages(chatIds, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0)
        logger.info({ count: messages.length }, 'New messages');
      for (const msg of messages) {
        try {
          await processMessage(msg);
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error(
            { err, msg: msg.id },
            'Error processing message, will retry',
          );
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

function ensureDockerAvailable(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
  } catch {
    throw new Error('Docker is not available. Ensure Docker daemon is running.');
  }

  try {
    const output = execSync('docker ps -a --filter name=nanoclaw- --format {{.Names}}', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    let ownContainerName = '';
    try {
      const hostname = (process.env.HOSTNAME || '').trim();
      if (hostname) {
        ownContainerName = execSync(
          `docker inspect ${hostname} --format {{.Name}}`,
          { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 3000 },
        ).trim().replace(/^\//, '');
      }
    } catch {}
    const stale = output
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n.startsWith('nanoclaw-') && n !== ownContainerName);
    if (stale.length > 0) {
      execSync(`docker rm -f ${stale.join(' ')}`, { stdio: 'pipe' });
      logger.info({ count: stale.length }, 'Cleaned up stale containers');
    }
  } catch {
  }
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error('TELEGRAM_BOT_TOKEN environment variable is required');
    process.exit(1);
  }

  ensureDockerAvailable();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  bot = new Bot(token);

  bot.on('message', async (ctx) => {
    const chatId = ctx.chat.id;
    const group = findGroupByChatId(chatId);
    if (!group) return;

    const msgId = ctx.message.message_id;
    const sender = ctx.from?.id || 0;
    const senderName =
      ctx.from?.first_name ||
      ctx.from?.username ||
      String(sender);
    const timestamp = new Date(ctx.message.date * 1000).toISOString();

    let content = ctx.message.text || ctx.message.caption || '';

    if (ctx.message.voice) {
      const transcription = await transcribeVoice(ctx.message.voice.file_id);
      if (transcription) {
        content = `[voice message] ${transcription}`;
      } else {
        content = '[voice message - transcription unavailable]';
      }
    }

    if (!content) return;

    const isFromMe = sender === bot.botInfo.id;

    storeChatMetadata(chatId, timestamp, ctx.chat.title || senderName);
    storeMessage(msgId, chatId, sender, senderName, content, timestamp, isFromMe);
  });

  bot.catch((err) => {
    logger.error({ err: err.error }, 'Bot error');
  });

  bot.start({
    onStart: () => {
      logger.info('Telegram bot started (long polling)');
      startSchedulerLoop({
        sendMessage,
        registeredGroups: () => registeredGroups,
        getSessions: () => sessions,
      });
      startIpcWatcher();
      startMessageLoop();
    },
  });
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
