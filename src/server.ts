import { createServer as createHttpServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Router } from './router.js';
import { ApiError, InternalError } from './errors.js';
import { log } from './logger.js';
import { config } from './config.js';
import { checkIpRateLimit, getRequestIp } from './rate-limit.js';

// Read version once at startup
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
export const VERSION: string = pkg.version;

// ── Route imports ─────────────────────────────────────────────────
import { healthHandler, liveHandler, readyHandler } from './routes/health.js';
import { messagesHandler } from './routes/messages.js';
import { agentHandler } from './routes/agent.js';
import { chatHandler } from './routes/chat.js';
import { listSessionsHandler, deleteSessionHandler } from './routes/sessions.js';
import { uploadHandler } from './routes/upload.js';
import { listFilesHandler, deleteFileHandler, downloadFileHandler } from './routes/files.js';
import { chatCompletionsHandler } from './routes/chat-completions.js';
import { usageHandler } from './routes/usage.js';
import { authSetupHandler, authLoginHandler, authStatusHandler } from './routes/auth.js';

export interface AppServer {
  router: Router;
  server: Server;
  start(port: number, host: string): Promise<void>;
  close(): Promise<void>;
}

// ── CORS helper ───────────────────────────────────────────────────

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin || '*';

  if (config.corsOrigins === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    const allowed = config.corsOrigins.split(',').map(o => o.trim());
    if (allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id, anthropic-version');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
}

// ── Security headers ──────────────────────────────────────────────

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0'); // CSP preferred over this legacy header
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

export function createApp(): AppServer {
  const router = new Router();

  // ── Register routes ──
  router.get('/health', healthHandler);
  router.get('/health/live', liveHandler);
  router.get('/health/ready', readyHandler);
  router.post('/v1/messages', messagesHandler);
  router.post('/v1/chat/completions', chatCompletionsHandler);
  router.post('/agent', agentHandler);
  router.post('/chat', chatHandler);
  router.get('/sessions', listSessionsHandler);
  router.delete('/sessions/:id', deleteSessionHandler);
  router.post('/upload', uploadHandler);
  router.get('/files', listFilesHandler);
  router.get('/files/:name', downloadFileHandler);
  router.delete('/files/:name', deleteFileHandler);
  router.get('/usage', usageHandler);
  router.post('/auth/setup', authSetupHandler);
  router.post('/auth/login', authLoginHandler);
  router.get('/auth/status/:login_id', authStatusHandler);

  // ── HTTP server ──
  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const startMs = Date.now();
    const method = req.method || 'GET';
    const url = req.url || '/';
    const requestId = (req.headers['x-request-id'] as string) || randomUUID().slice(0, 8);

    // Request ID + security headers on every response
    res.setHeader('X-Request-Id', requestId);
    setSecurityHeaders(res);
    setCorsHeaders(req, res);

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // IP rate limiting (skip for health checks)
    if (!url.startsWith('/health')) {
      const ip = getRequestIp(req);
      const rateCheck = checkIpRateLimit(ip);
      if (!rateCheck.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil((rateCheck.retryAfterMs || 60000) / 1000)) });
        res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Too many requests from this IP' } }));
        return;
      }
    }

    try {
      const match = router.match(method, url);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found_error', message: `${method} ${url} not found` } }));
        return;
      }
      await match.handler(req, res, match.params);
    } catch (err: unknown) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }

      if (err instanceof ApiError) {
        res.writeHead(err.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(err.toJSON()));
      } else {
        // Log full error server-side, return generic message to client
        log('error', 'Unhandled error', {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          method, url,
        });
        const internal = new InternalError();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(internal.toJSON()));
      }
    } finally {
      log('debug', 'Request', { requestId, method, url, status: res.statusCode, ms: Date.now() - startMs });
    }
  });

  server.keepAliveTimeout = 120_000; // 2 min — long enough for SSE agent responses

  return {
    router,
    server,
    start(port: number, host: string): Promise<void> {
      return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          const bound = typeof addr === 'string' ? addr : `${host}:${(addr as any).port}`;
          log('info', `ClaudeCodeAPI listening on ${bound}`);
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
