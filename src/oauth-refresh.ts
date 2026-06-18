/**
 * Claude.ai OAuth token management.
 * Reads tokens from ~/.claude/.credentials.json and auto-refreshes
 * before expiry so NanoClaw never needs manual re-authentication.
 */
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { request } from 'https';

import { logger } from './logger.js';

const CREDENTIALS_PATH = path.join(homedir(), '.claude', '.credentials.json');
const OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Refresh when less than 2 hours remaining — gives enough room to survive
// repeated rate-limit rejections from the token endpoint (each retry sequence
// takes ~2.5 min, followed by a 5-min cooldown, so a 30-min buffer is too
// narrow; 2 hours allows ~14 retry cycles before the token actually expires).
const REFRESH_BUFFER_MS = 2 * 60 * 60 * 1000;
// Max retries when the refresh endpoint returns a rate-limit error
const MAX_REFRESH_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 15_000;

interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

let refreshPromise: Promise<string> | null = null;
// Earliest time we'll attempt another refresh after a failed sequence
let refreshCooldownUntil = 0;
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between failed sequences

function readCredentials(): ClaudeCredentials | null {
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function doRefreshOnce(refreshToken: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString();

    const req = request(
      {
        hostname: 'platform.claude.com',
        path: '/v1/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'claude-code/2.1.76',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (!data.access_token) {
              reject(
                new Error(`OAuth refresh failed: ${JSON.stringify(data)}`),
              );
              return;
            }

            // Persist new tokens so the CLI also stays current
            const creds = readCredentials();
            if (creds?.claudeAiOauth) {
              creds.claudeAiOauth.accessToken = data.access_token;
              if (data.refresh_token) {
                creds.claudeAiOauth.refreshToken = data.refresh_token;
              }
              if (data.expires_in) {
                creds.claudeAiOauth.expiresAt =
                  Date.now() + data.expires_in * 1000;
              }
              writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
              logger.info(
                { path: CREDENTIALS_PATH },
                'OAuth credentials written to disk',
              );
            }

            logger.info('OAuth token refreshed successfully');
            resolve(data.access_token);
          } catch (err) {
            reject(err);
          }
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('rate_limit_error');
}

async function doRefresh(refreshToken: string): Promise<string> {
  for (let attempt = 0; attempt <= MAX_REFRESH_RETRIES; attempt++) {
    try {
      return await doRefreshOnce(refreshToken);
    } catch (err) {
      if (isRateLimitError(err) && attempt < MAX_REFRESH_RETRIES) {
        const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        logger.warn(
          { attempt: attempt + 1, delayMs },
          'OAuth refresh rate-limited, retrying after delay',
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  // Unreachable but satisfies TypeScript
  throw new Error('OAuth refresh exhausted retries');
}

/**
 * Returns a valid OAuth access token, refreshing automatically if needed.
 * Returns null if no credentials file exists (API key mode).
 */
export async function getOAuthToken(): Promise<string | null> {
  const creds = readCredentials();
  if (!creds?.claudeAiOauth) return null;

  const { accessToken, refreshToken, expiresAt } = creds.claudeAiOauth;

  const now = Date.now();

  // Still valid with buffer time remaining — no refresh needed
  if (accessToken && expiresAt > now + REFRESH_BUFFER_MS) {
    return accessToken;
  }

  // Skip refresh if we're in cooldown from a recent failed sequence
  if (now < refreshCooldownUntil) {
    return accessToken || null;
  }

  const tokenExpired = !accessToken || expiresAt <= now;

  // Start refresh if not already in progress
  if (!refreshPromise) {
    logger.info(
      { expiresAt: new Date(expiresAt).toISOString(), tokenExpired },
      tokenExpired
        ? 'OAuth token expired, refreshing (blocking)'
        : 'OAuth token near expiry, refreshing in background',
    );
    refreshPromise = doRefresh(refreshToken).finally(() => {
      refreshPromise = null;
    });
    refreshPromise.catch((err) => {
      refreshCooldownUntil = Date.now() + REFRESH_COOLDOWN_MS;
      logger.error(
        { err, retryAfter: new Date(refreshCooldownUntil).toISOString() },
        'OAuth token refresh failed, cooling down before next attempt',
      );
    });
  }

  // Token already expired — must wait for the refresh to complete
  if (tokenExpired) {
    try {
      return await refreshPromise;
    } catch {
      return null;
    }
  }

  // Token still valid but approaching expiry — return it while refresh runs in background
  return accessToken;
}

/** True if ~/.claude/.credentials.json exists with OAuth tokens. */
export function hasOAuthCredentials(): boolean {
  return readCredentials()?.claudeAiOauth !== undefined;
}

/**
 * Schedules a proactive token refresh every 6 hours.
 * Tokens expire ~12h so this ensures they're always refreshed well within
 * the expiry window regardless of when NanoClaw started.
 */
export function scheduleProactiveRefresh(): void {
  if (!hasOAuthCredentials()) return;

  const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

  async function doProactiveRefresh(force = false): Promise<void> {
    const creds = readCredentials();
    if (creds?.claudeAiOauth?.refreshToken) {
      const { expiresAt } = creds.claudeAiOauth;
      // On startup (force=false), skip if the token still has plenty of time
      // remaining — avoids hammering the token endpoint on every service restart.
      // The scheduled interval (force=true) always refreshes to ensure tokens
      // never drift close to expiry.
      if (!force && expiresAt && expiresAt > Date.now() + REFRESH_BUFFER_MS) {
        logger.info(
          { expiresAt: new Date(expiresAt).toISOString() },
          'OAuth token still fresh, skipping startup refresh',
        );
        return;
      }
      logger.info({ force }, 'Proactive OAuth token refresh');
      refreshPromise =
        refreshPromise ??
        doRefresh(creds.claudeAiOauth.refreshToken).finally(() => {
          refreshPromise = null;
        });
      try {
        await refreshPromise;
      } catch (err) {
        logger.error({ err }, 'Proactive OAuth refresh failed');
      }
    }
  }

  // On startup: only refresh if the token is near expiry (avoids rate-limiting
  // the token endpoint when the service restarts frequently with a fresh token).
  // On the 6-hour schedule: always force-refresh so tokens never drift to expiry.
  doProactiveRefresh(false);
  setInterval(() => doProactiveRefresh(true), REFRESH_INTERVAL_MS);

  logger.info(
    { intervalHours: 6 },
    'Proactive OAuth refresh scheduled (every 6 hours)',
  );
}
