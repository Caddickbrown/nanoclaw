/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const taskId = process.env.NANOCLAW_TASK_ID || null;

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

AVOID DOUBLE-SENDING: If the agent calls send_message("Reminder: do your physio"), it must NOT also output "Physio reminder sent" — that sends two messages. For reminders, write the prompt so the agent outputs the message text directly (no send_message call needed). Only use send_message inside a task when the agent needs to send multiple messages or send one mid-task while continuing to work.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'send_file',
  `Send a local file to the user via Telegram. The file must be saved to /workspace/ipc/files/ first.

Example usage:
1. Write your file to /workspace/ipc/files/report.pdf  (use Bash or Write tool)
2. Call send_file with filePath="files/report.pdf"

Supported file types: any file Telegram accepts (PDF, ZIP, images, text files, etc.)`,
  {
    filePath: z.string().describe('Path relative to /workspace/ipc/ (e.g., "files/report.pdf"). The file must exist at /workspace/ipc/{filePath}.'),
    caption: z.string().optional().describe('Optional caption to send with the file'),
  },
  async (args) => {
    // Validate the path stays within /workspace/ipc/files/
    const filesDir = path.join(IPC_DIR, 'files');
    const resolvedPath = path.resolve(IPC_DIR, args.filePath);
    if (!resolvedPath.startsWith(filesDir + path.sep) && resolvedPath !== filesDir) {
      return {
        content: [{ type: 'text' as const, text: `Invalid filePath: must be under files/ (e.g., "files/report.pdf"). Got: "${args.filePath}"` }],
        isError: true,
      };
    }
    if (!fs.existsSync(resolvedPath)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: /workspace/ipc/${args.filePath}` }],
        isError: true,
      };
    }

    const data: Record<string, string | undefined> = {
      type: 'file',
      chatJid,
      filePath: args.filePath,
      caption: args.caption,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'File queued for sending.' }] };
  },
);

server.tool(
  'send_reaction',
  `React to a message with an emoji. Telegram only. Use this to acknowledge messages without sending text.

The message_id comes from the incoming message context (e.g., "[Reaction: 👍 on message #1234]" or the message ID field).

Common emoji reactions: 👍 👎 ❤️ 🔥 🎉 😂 😮 😢 🙏`,
  {
    message_id: z.string().describe('The Telegram message ID to react to'),
    emoji: z.string().describe('The emoji to react with (e.g., "👍", "❤️", "🔥")'),
  },
  async (args) => {
    const data: Record<string, string> = {
      type: 'reaction',
      chatJid,
      messageId: args.message_id,
      emoji: args.emoji,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Reaction sent.' }] };
  },
);

server.tool(
  'fetch_rendered',
  'Fetch a URL using a headless browser that executes JavaScript. Use for React/Vue/Angular apps, SPAs, lazy-loaded pages, or any site that renders content client-side. Returns visible page text.',
  {
    url: z.string().describe('The URL to fetch and render'),
    timeout: z.number().optional().describe('Max seconds to wait for page load (default: 15)'),
    wait_until: z.enum(['networkidle', 'domcontentloaded', 'load']).optional().describe('Page event to wait for before returning (default: networkidle)'),
    max_length: z.number().optional().describe('Max characters to return (default: 8000)'),
  },
  async (args) => {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const timeout = args.timeout ?? 15;
    const waitUntil = args.wait_until ?? 'networkidle';
    const maxLength = args.max_length ?? 8000;

    try {
      const { stdout, stderr } = await execFileAsync('python3', [
        '/workspace/group/fetch_rendered.py',
        args.url,
        '--timeout', String(timeout),
        '--max-length', String(maxLength),
        '--wait-until', waitUntil,
      ], { timeout: (timeout + 10) * 1000 });

      const content = stdout || stderr || '(no content returned)';
      return { content: [{ type: 'text' as const, text: content }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `fetch_rendered failed: ${message}` }],
        isError: true,
      };
    }
  },
);


server.tool(
  'create_goal',
  `Create a persistent goal or intention to track over time. Goals survive across sessions and are reviewed during proactive heartbeats.

Use for things the user wants to achieve, habits to build, projects to complete, or ongoing intentions.

AUTONOMY LEVELS — how proactively the agent should act on this goal:
• suggest: Agent notices relevant opportunities and mentions them, but takes no action
• light: Agent queries tools (e.g. Linear) and proposes specific options with next steps
• medium: Agent takes minor reversible actions (e.g. create Linear issues, draft comments) and reports
• full: Agent acts autonomously, only reporting outcomes

ACTION CONTEXT — optional JSON with tool-specific config (e.g. {"linear_team_id": "xxx", "linear_project_id": "yyy"})`,
  {
    title: z.string().describe('Short goal title (e.g., "Exercise 3x per week")'),
    description: z.string().describe('More detail about the goal and what success looks like'),
    priority: z.enum(['high', 'medium', 'low']).optional().describe('Priority level (default: medium)'),
    target_date: z.string().optional().describe('Optional target date in YYYY-MM-DD format'),
    autonomy_level: z.enum(['suggest', 'light', 'medium', 'full']).optional().describe('How proactively to act on this goal (default: suggest)'),
    action_context: z.string().optional().describe('JSON string with tool config, e.g. {"linear_team_id": "xxx", "linear_project_id": "yyy"}'),
  },
  async (args) => {
    const data = {
      type: 'create_goal',
      title: args.title,
      description: args.description,
      priority: args.priority || 'medium',
      target_date: args.target_date || null,
      status: 'active',
      autonomy_level: args.autonomy_level || 'suggest',
      action_context: args.action_context || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Goal "${args.title}" created (autonomy: ${args.autonomy_level || 'suggest'}).` }] };
  },
);

server.tool(
  'update_goal',
  'Update an existing goal — change its status, autonomy level, add progress notes, update description or deadline.',
  {
    goal_id: z.string().describe('The goal ID to update'),
    status: z.enum(['active', 'completed', 'paused', 'abandoned']).optional().describe('New status'),
    priority: z.enum(['high', 'medium', 'low']).optional().describe('New priority'),
    description: z.string().optional().describe('Updated description'),
    target_date: z.string().optional().describe('New target date (YYYY-MM-DD)'),
    progress_note: z.string().optional().describe('Add a progress note (appended to history)'),
    autonomy_level: z.enum(['suggest', 'light', 'medium', 'full']).optional().describe('New autonomy level'),
    action_context: z.string().optional().describe('Updated JSON config string'),
  },
  async (args) => {
    const data: Record<string, unknown> = {
      type: 'update_goal',
      goalId: args.goal_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    if (args.status !== undefined) data.status = args.status;
    if (args.priority !== undefined) data.priority = args.priority;
    if (args.description !== undefined) data.description = args.description;
    if (args.target_date !== undefined) data.target_date = args.target_date;
    if (args.progress_note !== undefined) data.progress_note = args.progress_note;
    if (args.autonomy_level !== undefined) data.autonomy_level = args.autonomy_level;
    if (args.action_context !== undefined) data.action_context = args.action_context;
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Goal ${args.goal_id} updated.` }] };
  },
);

server.tool(
  'list_goals',
  'List tracked goals. Returns all goals or filtered by status.',
  {
    status: z.enum(['active', 'completed', 'paused', 'abandoned', 'all']).optional().describe('Filter by status (default: active)'),
  },
  async (args) => {
    const goalsFile = path.join(IPC_DIR, 'current_goals.json');
    try {
      if (!fs.existsSync(goalsFile)) {
        return { content: [{ type: 'text' as const, text: 'No goals found.' }] };
      }
      const allGoals = JSON.parse(fs.readFileSync(goalsFile, 'utf-8')) as Array<{
        id: string; title: string; description: string; status: string;
        priority: string; target_date: string | null; progress_notes: string;
        autonomy_level: string; action_context: string | null;
        created_at: string; updated_at: string;
      }>;
      const statusFilter = args.status || 'active';
      const goals = statusFilter === 'all' ? allGoals : allGoals.filter(g => g.status === statusFilter);
      if (goals.length === 0) {
        return { content: [{ type: 'text' as const, text: `No ${statusFilter === 'all' ? '' : statusFilter + ' '}goals found.` }] };
      }
      const formatted = goals.map(g => {
        const notes = JSON.parse(g.progress_notes || '[]') as string[];
        const lastNote = notes.length > 0 ? `\n  Last update: ${notes[notes.length - 1]}` : '';
        const autonomy = g.autonomy_level ? ` [${g.autonomy_level}]` : '';
        return `[${g.id}] ${g.priority.toUpperCase()} | ${g.status}${autonomy} | ${g.title}${g.target_date ? ` (due: ${g.target_date})` : ''}\n  ${g.description}${lastNote}`;
      }).join('\n\n');
      return { content: [{ type: 'text' as const, text: `Goals:\n\n${formatted}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'get_rate_limits',
  `Get current Anthropic API rate limit status — how many tokens/requests remain in the current window and when it resets.

Returns the most recently captured rate limit headers from the API. Updated on every API call the system makes.`,
  {},
  async () => {
    const limitsFile = path.join(IPC_DIR, 'rate_limits.json');
    try {
      if (!fs.existsSync(limitsFile)) {
        return { content: [{ type: 'text' as const, text: 'No rate limit data yet. Data is captured after the first API call.' }] };
      }
      const data = JSON.parse(fs.readFileSync(limitsFile, 'utf-8')) as Record<string, string>;
      if (Object.keys(data).length === 0) {
        return { content: [{ type: 'text' as const, text: 'No rate limit headers captured yet.' }] };
      }
      const capturedAt = data.captured_at || 'unknown';
      const lines: string[] = [`Rate limits (as of ${capturedAt}):\n`];
      for (const [key, value] of Object.entries(data)) {
        if (key === 'captured_at') continue;
        // Format key nicely: anthropic-ratelimit-tokens-remaining → Tokens Remaining
        const label = key.replace('anthropic-ratelimit-', '').replace(/-/g, ' ');
        lines.push(`  ${label}: ${value}`);
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'reschedule_self',
  `Change the schedule of the currently running task. Only works when running as a scheduled task.

Use this when you want to adapt your own schedule based on context — e.g. increase frequency during busy periods, shift timing, or pause if nothing to monitor.`,
  {
    schedule_type: z.enum(['cron', 'interval']).describe('New schedule type'),
    schedule_value: z.string().describe('New schedule value (cron expression or milliseconds)'),
  },
  async (args) => {
    if (!taskId) {
      return {
        content: [{ type: 'text' as const, text: 'Not running as a scheduled task — reschedule_self is only available during task execution.' }],
        isError: true,
      };
    }
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }
    const data = {
      type: 'update_task',
      taskId,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Schedule updated to ${args.schedule_type}: ${args.schedule_value}` }] };
  },
);

server.tool(
  'send_checkin',
  `Send a message with tap-to-respond inline buttons (Telegram only). Returns a checkin_id you can use with get_checkin_result to see if Dan responded.

Use for quick responses: physio done, workout completed, task acknowledged, etc.

Example: send_checkin("Did you do your physio?", [{label: "✅ Done", value: "done"}, {label: "❌ Missed", value: "missed"}, {label: "⏭ Skipped", value: "skipped"}])

The buttons appear as tappable options in Telegram. Dan taps one, the message updates to show the choice, and the result is recorded. Call get_checkin_result with the returned ID to read the response.`,
  {
    text: z.string().describe('The question or prompt to show Dan'),
    buttons: z.array(z.object({
      label: z.string().describe('Button label shown in Telegram (e.g. "✅ Done")'),
      value: z.string().max(20).describe('Short value stored when tapped (e.g. "done", "missed"). Keep short — no spaces.'),
    })).min(1).max(6).describe('Button options (max 6)'),
    task_context: z.string().optional().describe('Optional tag to identify this checkin (e.g. "physio-2026-05-05")'),
  },
  async (args) => {
    const checkinId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data: Record<string, unknown> = {
      type: 'message_with_buttons',
      chatJid,
      text: args.text,
      buttons: args.buttons,
      checkinId,
      taskContext: args.task_context || null,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return {
      content: [{
        type: 'text' as const,
        text: `Check-in sent. ID: ${checkinId}\n\nCall get_checkin_result("${checkinId}") to see if Dan responded.`,
      }],
    };
  },
);

server.tool(
  'get_checkin_result',
  'Check if Dan has responded to a check-in sent with send_checkin. Returns the response (label + value + timestamp) if available, or a "not yet answered" message.',
  {
    checkin_id: z.string().describe('The checkin ID returned by send_checkin'),
  },
  async (args) => {
    const resultPath = path.join('/workspace/group/checkin_results', `${args.checkin_id}.json`);

    if (!fs.existsSync(resultPath)) {
      return {
        content: [{ type: 'text' as const, text: `No response yet for checkin ${args.checkin_id}. Dan hasn't tapped a button yet.` }],
      };
    }

    try {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading checkin result: ${err}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
