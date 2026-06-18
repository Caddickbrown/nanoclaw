/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

import { logUsage, setRouterState } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { hasOAuthCredentials } from './oauth-refresh.js';

function captureRateLimitHeaders(
  headers: Record<string, string | string[] | undefined>,
): void {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith('anthropic-ratelimit-') && typeof value === 'string') {
      data[key] = value;
    }
  }
  if (Object.keys(data).length > 0) {
    try {
      setRouterState(
        'rate_limits',
        JSON.stringify({ captured_at: new Date().toISOString(), ...data }),
      );
    } catch {
      /* never break the proxy */
    }
  }
}

function readOAuthToken(): string | null {
  try {
    const creds = JSON.parse(
      readFileSync(
        path.join(homedir(), '.claude', '.credentials.json'),
        'utf8',
      ),
    );
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'AUTH_MODE',
  ]);

  const authMode: AuthMode =
    secrets.AUTH_MODE === 'oauth'
      ? 'oauth'
      : secrets.AUTH_MODE === 'api-key'
        ? 'api-key'
        : secrets.ANTHROPIC_API_KEY
          ? 'api-key'
          : 'oauth';

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            // Read token from credentials file — kept fresh by system 2 (systemd timers)
            const oauthToken = readOAuthToken();
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const isMessageRequest =
          req.method === 'POST' && req.url === '/v1/messages';

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            captureRateLimitHeaders(
              upRes.headers as Record<string, string | string[] | undefined>,
            );
            res.writeHead(upRes.statusCode!, upRes.headers);

            if (!isMessageRequest || upRes.statusCode !== 200) {
              upRes.pipe(res);
              return;
            }

            const contentType = upRes.headers['content-type'] || '';
            const isSSE = contentType.includes('text/event-stream');

            if (isSSE) {
              let sseBuffer = '';
              let model = '';
              let inputTokens = 0;
              let outputTokens = 0;

              upRes.on('data', (chunk: Buffer) => {
                res.write(chunk);
                sseBuffer += chunk.toString();
                let idx: number;
                while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
                  const event = sseBuffer.slice(0, idx);
                  sseBuffer = sseBuffer.slice(idx + 2);
                  const match = event.match(/^data: (.+)$/m);
                  if (!match || match[1] === '[DONE]') continue;
                  try {
                    const data = JSON.parse(match[1]);
                    if (data.type === 'message_start' && data.message) {
                      if (data.message.model) model = data.message.model;
                      inputTokens += data.message.usage?.input_tokens || 0;
                    } else if (data.type === 'message_delta' && data.usage) {
                      outputTokens = data.usage.output_tokens || outputTokens;
                    }
                  } catch {
                    /* ignore parse errors */
                  }
                }
              });

              upRes.on('end', () => {
                res.end();
                if (model && (inputTokens || outputTokens)) {
                  logUsage({
                    timestamp: new Date().toISOString(),
                    model,
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    is_streaming: true,
                  });
                }
              });
            } else {
              const chunks: Buffer[] = [];
              upRes.on('data', (c: Buffer) => chunks.push(c));
              upRes.on('end', () => {
                const body = Buffer.concat(chunks);
                res.end(body);
                try {
                  const data = JSON.parse(body.toString());
                  if (data.model && data.usage) {
                    logUsage({
                      timestamp: new Date().toISOString(),
                      model: data.model,
                      input_tokens: data.usage.input_tokens || 0,
                      output_tokens: data.usage.output_tokens || 0,
                      is_streaming: false,
                    });
                  }
                } catch {
                  /* ignore parse errors */
                }
              });
            }
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY', 'AUTH_MODE']);
  if (secrets.AUTH_MODE === 'oauth') return 'oauth';
  if (secrets.AUTH_MODE === 'api-key') return 'api-key';
  if (secrets.ANTHROPIC_API_KEY) return 'api-key';
  return hasOAuthCredentials() ? 'oauth' : 'oauth';
}
