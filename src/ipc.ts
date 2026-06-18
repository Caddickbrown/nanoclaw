import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, TIMEZONE } from './config.js';
import { sendPoolMessage } from './channels/telegram.js';
import { AvailableGroup } from './container-runner.js';
import {
  addGoalProgress,
  createGoal,
  createTask,
  deleteTask,
  getGoalById,
  getGoalByTitle,
  getTaskById,
  updateGoal,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { Goal, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendFile: (jid: string, filePath: string, caption?: string) => Promise<void>;
  sendReaction: (
    jid: string,
    messageId: string,
    emoji: string,
  ) => Promise<void>;
  sendMessageWithButtons: (
    jid: string,
    text: string,
    buttons: Array<{ label: string; value: string }>,
    checkinId: string,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;
let lastErrorCleanup = 0;
const ERROR_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const ERROR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// inotify-based watchers: key is the watched directory path
const ipcWatchers = new Map<string, fs.FSWatcher>();

// Debounce flag: prevents queuing multiple processIpcFiles calls
let processPending = false;
// Concurrency guard: prevents processIpcFiles from running twice simultaneously.
// inotify events and the 5s fallback poll can both fire around the same time;
// without this, both would read the same IPC file before either deletes it, causing
// the same message to be sent multiple times.
let isProcessing = false;
let runAgainAfter = false;

function triggerProcess(processIpcFiles: () => void): void {
  if (processPending) return;
  processPending = true;
  setImmediate(() => {
    processPending = false;
    processIpcFiles();
  });
}

function watchGroupIpcDirs(
  groupFolder: string,
  ipcBaseDir: string,
  processIpcFiles: () => void,
): void {
  const dirsToWatch = [
    path.join(ipcBaseDir, groupFolder, 'messages'),
    path.join(ipcBaseDir, groupFolder, 'tasks'),
  ];

  for (const dir of dirsToWatch) {
    if (ipcWatchers.has(dir)) continue; // already watching
    if (!fs.existsSync(dir)) continue; // dir not yet created

    try {
      const watcher = fs.watch(dir, (eventType) => {
        // On Linux, 'rename' fires on file creation and deletion
        if (eventType === 'rename') {
          triggerProcess(processIpcFiles);
        }
      });

      watcher.on('error', (err) => {
        logger.warn({ dir, err }, 'IPC fs.watch error — removing watcher');
        ipcWatchers.delete(dir);
        watcher.close();
      });

      ipcWatchers.set(dir, watcher);
      logger.debug({ dir }, 'IPC fs.watch started');
    } catch (err) {
      logger.warn({ dir, err }, 'Failed to start fs.watch on IPC dir');
    }
  }
}

function cleanupOldErrorFiles(ipcBaseDir: string): void {
  const now = Date.now();
  if (now - lastErrorCleanup < ERROR_CLEANUP_INTERVAL_MS) return;
  lastErrorCleanup = now;

  const errorDir = path.join(ipcBaseDir, 'errors');
  if (!fs.existsSync(errorDir)) return;

  try {
    const files = fs.readdirSync(errorDir);
    for (const file of files) {
      const filePath = path.join(errorDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > ERROR_MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          logger.info({ file }, 'Deleted old IPC error file');
        }
      } catch (err) {
        logger.warn({ file, err }, 'Failed to stat/delete IPC error file');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read IPC errors directory during cleanup');
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    if (isProcessing) {
      runAgainAfter = true;
      return;
    }
    isProcessing = true;
    try {
      await processIpcFilesInner();
    } finally {
      isProcessing = false;
      if (runAgainAfter) {
        runAgainAfter = false;
        setImmediate(processIpcFiles);
      }
    }
  };

  const processIpcFilesInner = async () => {
    cleanupOldErrorFiles(ipcBaseDir);

    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, 5000);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    const knownFolders = new Set<string>();
    for (const group of Object.values(registeredGroups)) {
      knownFolders.add(group.folder);
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      // Only process directories that correspond to a known registered group folder
      if (!knownFolders.has(sourceGroup)) {
        logger.warn({ sourceGroup }, 'IPC: skipping unknown group folder');
        continue;
      }
      // Ensure inotify watchers are active for this group's IPC subdirs
      watchGroupIpcDirs(sourceGroup, ipcBaseDir, processIpcFiles);
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (data.sender && data.chatJid.startsWith('tg:')) {
                    await sendPoolMessage(
                      data.chatJid,
                      data.text,
                      data.sender,
                      sourceGroup,
                    );
                  } else {
                    await deps.sendMessage(data.chatJid, data.text);
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'reaction' &&
                data.chatJid &&
                data.messageId &&
                data.emoji
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendReaction(
                    data.chatJid,
                    data.messageId,
                    data.emoji,
                  );
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      messageId: data.messageId,
                      emoji: data.emoji,
                    },
                    'IPC reaction sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC reaction attempt blocked',
                  );
                }
              } else if (
                (data.type === 'file' || data.type === 'voice') &&
                data.chatJid &&
                data.filePath
              ) {
                // Resolve file path relative to this group's IPC dir and validate
                const groupIpcDir = path.join(ipcBaseDir, sourceGroup);
                const resolvedPath = path.resolve(groupIpcDir, data.filePath);
                if (!resolvedPath.startsWith(groupIpcDir + path.sep)) {
                  logger.warn(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      filePath: data.filePath,
                    },
                    'Blocked IPC file send: path escapes group IPC dir',
                  );
                } else {
                  const targetGroup = registeredGroups[data.chatJid];
                  if (
                    isMain ||
                    (targetGroup && targetGroup.folder === sourceGroup)
                  ) {
                    await deps.sendFile(
                      data.chatJid,
                      resolvedPath,
                      data.caption,
                    );
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        filePath: resolvedPath,
                      },
                      'IPC file sent',
                    );
                  } else {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup },
                      'Unauthorized IPC file send attempt blocked',
                    );
                  }
                }
              } else if (
                data.type === 'message_with_buttons' &&
                data.chatJid &&
                data.text &&
                Array.isArray(data.buttons) &&
                data.checkinId
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessageWithButtons(
                    data.chatJid,
                    data.text,
                    data.buttons as Array<{ label: string; value: string }>,
                    data.checkinId,
                  );
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      checkinId: data.checkinId,
                      sourceGroup,
                    },
                    'IPC checkin message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC checkin attempt blocked',
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

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
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

    // Fallback poll every 5 seconds — catches any events inotify may have missed
    setTimeout(processIpcFiles, 5000);
  };

  processIpcFiles();
  logger.info(
    'IPC watcher started (per-group namespaces, inotify + 5s fallback poll)',
  );
}

export function stopIpcWatcher(): void {
  for (const [dir, watcher] of ipcWatchers) {
    try {
      watcher.close();
      logger.debug({ dir }, 'IPC fs.watch closed');
    } catch (err) {
      logger.warn({ dir, err }, 'Error closing IPC fs.watch');
    }
  }
  ipcWatchers.clear();
  ipcWatcherRunning = false;
  logger.info('IPC watcher stopped');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For create_goal / update_goal
    goalId?: string;
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    target_date?: string;
    progress_note?: string;
    autonomy_level?: string;
    action_context?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

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
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
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
        const task = getTaskById(data.taskId);
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
        const task = getTaskById(data.taskId);
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

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'create_goal':
      if (data.title && data.description) {
        const existingGoal = getGoalByTitle(data.title, sourceGroup);
        if (existingGoal) {
          logger.info(
            { existingId: existingGoal.id, title: data.title },
            'Skipping duplicate goal creation',
          );
          break;
        }
        const goalId = createGoal({
          group_folder: sourceGroup,
          title: data.title,
          description: data.description,
          status: (data.status as 'active') || 'active',
          priority: (data.priority as 'medium') || 'medium',
          target_date: data.target_date || null,
          progress_notes: '[]',
          autonomy_level:
            (data.autonomy_level as Goal['autonomy_level']) || 'suggest',
          action_context: data.action_context || null,
        });
        logger.info({ goalId, sourceGroup }, 'Goal created via IPC');
      }
      break;

    case 'update_goal':
      if (data.goalId) {
        const goal = getGoalById(data.goalId);
        if (goal && (isMain || goal.group_folder === sourceGroup)) {
          if (data.progress_note) {
            addGoalProgress(data.goalId, data.progress_note);
          }
          const goalFields = {
            ...(data.title !== undefined && { title: data.title }),
            ...(data.description !== undefined && {
              description: data.description,
            }),
            ...(data.status !== undefined && {
              status: data.status as Goal['status'],
            }),
            ...(data.priority !== undefined && {
              priority: data.priority as Goal['priority'],
            }),
            ...(data.target_date !== undefined && {
              target_date: data.target_date,
            }),
            ...(data.autonomy_level !== undefined && {
              autonomy_level: data.autonomy_level as Goal['autonomy_level'],
            }),
            ...(data.action_context !== undefined && {
              action_context: data.action_context,
            }),
          };
          if (Object.keys(goalFields).length > 0) {
            updateGoal(data.goalId, goalFields);
          }
          logger.info(
            { goalId: data.goalId, sourceGroup },
            'Goal updated via IPC',
          );
        } else {
          logger.warn(
            { goalId: data.goalId, sourceGroup },
            'Unauthorized goal update attempt',
          );
        }
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
