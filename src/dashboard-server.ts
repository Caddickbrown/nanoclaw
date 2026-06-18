/**
 * Cron Dashboard HTTP server.
 * Serves the task dashboard UI and REST API on port 8766.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';

import { getAllTasks, getTaskById, updateTask, deleteTask } from './db.js';
import { computeNextRun } from './task-scheduler.js';
import { logger } from './logger.js';
import { ScheduledTask } from './types.js';
import { DASHBOARD_PORT } from './config.js';
const DASHBOARD_HTML = path.resolve(process.cwd(), 'dashboard.html');
const FAVICON = path.resolve(
  process.cwd(),
  'groups/telegram_main/feed/static/icons/apple-touch-icon-tasks.png',
);

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const MAX_BODY_SIZE = 65536; // 64 KB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let totalLength = 0;
    req.on('data', (chunk: Buffer | string) => {
      totalLength += Buffer.byteLength(chunk);
      if (totalLength > MAX_BODY_SIZE) {
        req.destroy();
        reject(Object.assign(new Error('Payload too large'), { code: 413 }));
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function taskToApiShape(task: ScheduledTask) {
  const preview = task.prompt.trim().split(/\s+/).slice(0, 12).join(' ');
  return {
    id: task.id,
    preview:
      preview.length < task.prompt.trim().length ? preview + '…' : preview,
    full_prompt: task.prompt,
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    status: task.status,
    next_run: task.next_run,
    last_run: task.last_run,
    last_result: task.last_result,
    context_mode: task.context_mode,
    group_folder: task.group_folder,
    created_at: task.created_at,
  };
}

export function startDashboardServer(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${DASHBOARD_PORT}`);
      const method = req.method?.toUpperCase() || 'GET';

      // CORS preflight
      if (method === 'OPTIONS') {
        cors(res);
        res.writeHead(204);
        res.end();
        return;
      }

      // Favicon
      if (method === 'GET' && url.pathname === '/favicon.png') {
        try {
          const data = fs.readFileSync(FAVICON);
          cors(res);
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(data);
        } catch {
          res.writeHead(404);
          res.end();
        }
        return;
      }

      // Dashboard HTML
      if (method === 'GET' && url.pathname === '/') {
        try {
          const html = fs.readFileSync(DASHBOARD_HTML, 'utf8');
          cors(res);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch {
          cors(res);
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('dashboard.html not found');
        }
        return;
      }

      // GET /api/tasks
      if (method === 'GET' && url.pathname === '/api/tasks') {
        try {
          const tasks = getAllTasks().map(taskToApiShape);
          json(res, 200, tasks);
        } catch (err) {
          logger.error({ err }, 'Dashboard: failed to list tasks');
          json(res, 500, { error: 'Internal error' });
        }
        return;
      }

      // PATCH /api/tasks/:id
      const patchMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (method === 'PATCH' && patchMatch) {
        const id = decodeURIComponent(patchMatch[1]);
        readBody(req)
          .then((body) => {
            let payload: { schedule_type?: string; schedule_value?: string };
            try {
              payload = JSON.parse(body);
            } catch {
              json(res, 400, { error: 'Invalid JSON' });
              return;
            }

            const task = getTaskById(id);
            if (!task) {
              json(res, 404, { error: 'Task not found' });
              return;
            }

            const updates: Parameters<typeof updateTask>[1] = {};

            if ((payload as any).prompt !== undefined) {
              updates.prompt = String((payload as any).prompt);
            }
            if (payload.schedule_type !== undefined) {
              if (
                !['cron', 'interval', 'once'].includes(payload.schedule_type)
              ) {
                json(res, 400, { error: 'Invalid schedule_type' });
                return;
              }
              updates.schedule_type =
                payload.schedule_type as ScheduledTask['schedule_type'];
            }
            if (payload.schedule_value !== undefined) {
              updates.schedule_value = payload.schedule_value;
            }

            // Recompute next_run with updated schedule
            const updated: ScheduledTask = {
              ...task,
              ...updates,
            };
            const nextRun = computeNextRun(updated);
            updates.next_run = nextRun;

            updateTask(id, updates);
            json(res, 200, { ok: true });
          })
          .catch((err: NodeJS.ErrnoException & { code?: number }) => {
            if (err.code === 413) {
              json(res, 413, { error: 'Payload too large' });
              return;
            }
            logger.error({ err, id }, 'Dashboard: failed to update task');
            json(res, 500, { error: 'Internal error' });
          });
        return;
      }

      // POST /api/tasks/:id/pause
      const pauseMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/pause$/);
      if (method === 'POST' && pauseMatch) {
        const id = decodeURIComponent(pauseMatch[1]);
        const task = getTaskById(id);
        if (!task) {
          json(res, 404, { error: 'Task not found' });
          return;
        }
        updateTask(id, { status: 'paused' });
        json(res, 200, { ok: true });
        return;
      }

      // POST /api/tasks/:id/resume
      const resumeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
      if (method === 'POST' && resumeMatch) {
        const id = decodeURIComponent(resumeMatch[1]);
        const task = getTaskById(id);
        if (!task) {
          json(res, 404, { error: 'Task not found' });
          return;
        }
        updateTask(id, { status: 'active' });
        json(res, 200, { ok: true });
        return;
      }

      // DELETE /api/tasks/:id
      const deleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (method === 'DELETE' && deleteMatch) {
        const id = decodeURIComponent(deleteMatch[1]);
        const task = getTaskById(id);
        if (!task) {
          json(res, 404, { error: 'Task not found' });
          return;
        }
        deleteTask(id);
        json(res, 200, { ok: true });
        return;
      }

      // 404
      json(res, 404, { error: 'Not found' });
    });

    server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
      logger.info({ port: DASHBOARD_PORT }, 'Dashboard server listening');
      resolve(server);
    });

    server.on('error', reject);
  });
}
