import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TELEGRAM_BOT_POOL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { initBotPool } from './channels/telegram.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGoalsSnapshot,
  writeGroupsSnapshot,
  writeRateLimitsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  createGoal,
  createTask,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getGoalById,
  getMessagesSince,
  getNewMessages,
  getRateLimits,
  getRegisteredGroup,
  getRouterState,
  getTaskById,
  initDatabase,
  listGoals,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  updateGoal,
  updateTask,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startDashboardServer } from './dashboard-server.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

import type { Goal } from './types.js';

function buildContextPreamble(goals: Goal[]): string {
  const activeGoals = goals.filter((g) => g.status === 'active');
  if (activeGoals.length === 0) return '';

  const lines = activeGoals
    .map((g) => {
      const due = g.target_date ? ` (due: ${g.target_date})` : '';
      const notes = JSON.parse(g.progress_notes || '[]') as string[];
      const lastNote =
        notes.length > 0 ? `\n    Last: ${notes[notes.length - 1]}` : '';
      return `  - [${g.id}] ${g.priority.toUpperCase()} | ${g.title}${due}: ${g.description}${lastNote}`;
    })
    .join('\n');

  return `<active_goals>\n${lines}\n</active_goals>\n\n`;
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  // Full context: user messages + bot responses since the cursor so the agent
  // can see the conversation history including what it previously said.
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );
  // Non-bot messages: used for trigger checks and cursor advancement.
  // is_bot_message is true only for NanoClaw's own stored responses (storeMessageDirect).
  // Do NOT use is_from_me here — in Telegram DMs the user's own messages also have
  // is_from_me=true, so that field cannot distinguish user messages from bot responses.
  // Bot message timestamps can also be newer than user messages (stored at send time),
  // so the cursor must only advance to non-bot timestamps to avoid skipping queued messages.
  const nonBotMessages = missedMessages.filter((m) => !m.is_bot_message);

  if (nonBotMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = nonBotMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor to last non-bot message timestamp. Never use bot message
  // timestamps: they are stored at send-time and can be newer than queued user
  // messages, which would cause those user messages to be skipped.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    nonBotMessages[nonBotMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = stripInternalTags(raw);
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        const ts = new Date().toISOString();
        storeMessageDirect({
          id: `bot_${chatJid}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          chat_jid: chatJid,
          sender: 'bot',
          sender_name: ASSISTANT_NAME,
          content: text,
          timestamp: ts,
          is_from_me: true,
          is_bot_message: true,
        });
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  // If the agent ran without error but sent no output (null result), roll back
  // the cursor and retry — handles rate-limit interruptions and other silent failures.
  if (!outputSentToUser) {
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent returned no output, rolling back cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
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

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Write goal and rate limit snapshots + inject active goals as context
  const goals = listGoals(group.folder);
  writeGoalsSnapshot(group.folder, goals);
  writeRateLimitsSnapshot(group.folder, getRateLimits());
  const preamble = buildContextPreamble(goals);
  const fullPrompt = preamble ? `${preamble}${prompt}` : prompt;

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: fullPrompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // Only advance to the last non-bot message timestamp — bot message
            // timestamps can be newer than queued user messages and would skip them.
            const lastNonBotMsg = messagesToSend
              .filter((m) => !m.is_bot_message)
              .at(-1);
            if (lastNonBotMsg) {
              lastAgentTimestamp[chatJid] = lastNonBotMsg.timestamp;
              saveState();
            }
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }

    // Renew typing indicators for groups with active message containers.
    // Telegram's typing indicator expires after ~5s, so we refresh it every poll cycle.
    for (const chatJid of Object.keys(registeredGroups)) {
      if (queue.isActiveMessageContainer(chatJid)) {
        const channel = findChannel(channels, chatJid);
        channel?.setTyping?.(chatJid, true)?.catch(() => {});
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

const HEARTBEAT_PROMPT = `You are running as a proactive daily review agent.

The user is on the Anthropic Max plan. Usage resets every Thursday at 20:00 local time.

Steps:
1. Check active goals: mcp__nanoclaw__list_goals

2. Check weekly token usage pace. First get the last reset timestamp:
   python3 -c "
from datetime import datetime, timedelta
now = datetime.now()
days = (now.weekday() - 3) % 7
reset = (now - timedelta(days=days)).replace(hour=20, minute=0, second=0, microsecond=0)
if reset > now: reset -= timedelta(days=7)
print(reset.isoformat())
"
   Then query usage since that reset (replace <RESET> with output above):
   sqlite3 /workspace/project/store/messages.db "SELECT SUM(input_tokens+output_tokens) as total, COUNT(*) as calls FROM usage_log WHERE timestamp >= '<RESET>';"
   And last week for comparison:
   sqlite3 /workspace/project/store/messages.db "SELECT SUM(input_tokens+output_tokens) as total FROM usage_log WHERE timestamp >= datetime('<RESET>','-7 days') AND timestamp < '<RESET>';"
   Calculate: days elapsed, days until next Thursday 20:00, projected total at current pace vs last week.
   WARN the user if projected total is >30% above last week's total, or if pace is accelerating significantly.

3. Scan recent context for anything needing follow-up.
4. Check scheduled tasks: mcp__nanoclaw__list_tasks

Decision:
- Something needs attention → send a message.
- Everything fine → output only <internal>Nothing to report today.</internal>

Adjust schedule if needed: mcp__nanoclaw__reschedule_self
Be concise. Only message when there's genuine value.`;

function ensureHeartbeatTask(mainJid: string, mainFolder: string): void {
  const schedule = '30 8 * * *';
  let nextRun: string | undefined;
  try {
    nextRun =
      CronExpressionParser.parse(schedule, { tz: TIMEZONE })
        .next()
        .toISOString() ?? undefined;
  } catch {
    return;
  }
  if (!nextRun) return;

  const existing = getTaskById('heartbeat-main');
  if (existing) {
    // Always refresh prompt so config changes apply on restart
    updateTask('heartbeat-main', { prompt: HEARTBEAT_PROMPT });
    return;
  }

  createTask({
    id: 'heartbeat-main',
    group_folder: mainFolder,
    chat_jid: mainJid,
    prompt: HEARTBEAT_PROMPT,
    schedule_type: 'cron',
    schedule_value: schedule,
    context_mode: 'group',
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  logger.info({ nextRun }, 'Heartbeat task registered');
}

const GOAL_REVIEW_PROMPT = `You are running a proactive goal review. Check active goals and propose concrete next actions.

Steps:
1. Load active goals: mcp__nanoclaw__list_goals (status: active)

2. For each goal with autonomy_level "light", "medium", or "full":
   - Parse action_context JSON if present (contains tool config like linear_team_id, linear_project_name)
   - Query the relevant tool for current state
   - Identify 2-3 specific actionable next steps

3. For goals with Linear action context, query Linear:
   python3 << 'EOF'
   import urllib.request, json
   KEY = open('/workspace/group/docs/linear_key.txt').read().strip() if __import__('os').path.exists('/workspace/group/docs/linear_key.txt') else None
   if not KEY:
       import sys
       # Read from linear.md
       with open('/workspace/group/docs/linear.md') as f:
           for line in f:
               if 'lin_api_' in line and 'caddickbrown' in line.lower():
                   KEY = line.split('lin_api_')[1].split('|')[0].strip()
                   KEY = 'lin_api_' + KEY
                   break
               elif 'Use this for everything' in line:
                   pass
   # Get project issues
   def gql(q, v=None):
       body = json.dumps({'query': q, 'variables': v or {}}).encode()
       req = urllib.request.Request('https://api.linear.app/graphql', data=body,
           headers={'Authorization': KEY, 'Content-Type': 'application/json'})
       return json.loads(urllib.request.urlopen(req).read())
   # List projects to find ID
   r = gql('{ projects(first: 20) { nodes { id name } } }')
   for p in r['data']['projects']['nodes']:
       print(p['id'], p['name'])
   EOF

   Then fetch open issues for the relevant project and summarize: what's in progress, what's unstarted and ready, what's blocked.

4. Formulate 2-3 concrete options for each actionable goal. Be specific — not "work on Island" but "pick up issue CAD-42 (Tile rendering system) which is unstarted and unblocked".

5. Send message ONLY if there are actionable suggestions. Format:
   *Goal: [title]* ([autonomy_level])
   Options:
   • Option A: [specific action]
   • Option B: [specific action]

   Reply with a number to act, or "skip" to move on.

If no goals have meaningful options right now, output only:
<internal>Goal review: nothing actionable this cycle.</internal>`;

function ensureGoalReviewTask(mainJid: string, mainFolder: string): void {
  // Mon, Wed, Fri at 10:00
  const schedule = '0 10 * * 1,3,5';
  let nextRun: string | undefined;
  try {
    nextRun =
      CronExpressionParser.parse(schedule, { tz: TIMEZONE })
        .next()
        .toISOString() ?? undefined;
  } catch {
    return;
  }
  if (!nextRun) return;

  const existing = getTaskById('goal-review-main');
  if (existing) {
    updateTask('goal-review-main', { prompt: GOAL_REVIEW_PROMPT });
    return;
  }

  createTask({
    id: 'goal-review-main',
    group_folder: mainFolder,
    chat_jid: mainJid,
    prompt: GOAL_REVIEW_PROMPT,
    schedule_type: 'cron',
    schedule_value: schedule,
    context_mode: 'group',
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  logger.info({ nextRun }, 'Goal review task registered');
}

const ISLAND_GOAL_ID = 'goal-island-engine';

function ensureIslandGoal(mainFolder: string): void {
  const existing = getGoalById(ISLAND_GOAL_ID);
  if (existing) return;

  createGoal({
    group_folder: mainFolder,
    title: 'Island Engine',
    description:
      'Build the Island game — an island sim with zones, prototype systems, characters, job mini-games, and a solarpunk world. Track progress via Linear Island project.',
    status: 'active',
    priority: 'high',
    target_date: null,
    progress_notes: '[]',
    autonomy_level: 'light',
    action_context: JSON.stringify({
      linear_team_id: '40839dfc-0149-415a-8a3e-3fd46c5b3c66',
      linear_project_name: 'Island',
    }),
  });

  logger.info('Island Engine goal created');
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  const mainEntry = Object.entries(registeredGroups).find(([, g]) => g.isMain);
  if (mainEntry) {
    ensureHeartbeatTask(mainEntry[0], mainEntry[1].folder);
    ensureGoalReviewTask(mainEntry[0], mainEntry[1].folder);
    ensureIslandGoal(mainEntry[1].folder);
  }

  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Start cron dashboard server
  const dashboardServer = await startDashboardServer();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    dashboardServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  if (TELEGRAM_BOT_POOL.length > 0) {
    await initBotPool(TELEGRAM_BOT_POOL);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) {
        await channel.sendMessage(jid, text);
        const ts = new Date().toISOString();
        storeMessageDirect({
          id: `bot_${jid}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          chat_jid: jid,
          sender: 'bot',
          sender_name: ASSISTANT_NAME,
          content: text,
          timestamp: ts,
          is_from_me: true,
          is_bot_message: true,
        });
      }
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendFile: (jid, filePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendFile)
        throw new Error(`Channel for ${jid} does not support sendFile`);
      return channel.sendFile(jid, filePath, caption);
    },
    sendReaction: (jid, messageId, emoji) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendReaction)
        throw new Error(`Channel for ${jid} does not support sendReaction`);
      return channel.sendReaction(jid, messageId, emoji);
    },
    sendMessageWithButtons: (jid, text, buttons, checkinId) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendMessageWithButtons)
        throw new Error(
          `Channel for ${jid} does not support sendMessageWithButtons`,
        );
      return channel.sendMessageWithButtons(jid, text, buttons, checkinId);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
