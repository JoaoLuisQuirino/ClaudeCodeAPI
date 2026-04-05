import { createServer as createHttpServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { Router } from './router.js';
import { ApiError, InternalError } from './errors.js';
import { log } from './logger.js';

// ── Route imports ─────────────────────────────────────────────────
import { healthHandler, liveHandler, readyHandler } from './routes/health.js';
import { messagesHandler } from './routes/messages.js';
import { agentHandler } from './routes/agent.js';
import { chatHandler } from './routes/chat.js';
import { listSessionsHandler, deleteSessionHandler } from './routes/sessions.js';
import { uploadHandler } from './routes/upload.js';
import { listFilesHandler, deleteFileHandler } from './routes/files.js';
import { chatCompletionsHandler } from './routes/chat-completions.js';
import { usageHandler } from './routes/usage.js';

export interface AppServer {
  router: Router;
  server: Server;
  start(port: number, host: string): Promise<void>;
  close(): Promise<void>;
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
  router.delete('/files/:name', deleteFileHandler);
  router.get('/usage', usageHandler);

  // ── HTTP server ──
  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const startMs = Date.now();
    const method = req.method || 'GET';
    const url = req.url || '/';

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id, anthropic-version');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
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
        // SSE already started — just close
        if (!res.writableEnded) res.end();
        return;
      }

      if (err instanceof ApiError) {
        res.writeHead(err.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(err.toJSON()));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        log('error', 'Unhandled error', {
          error: msg,
          stack: err instanceof Error ? err.stack : undefined,
          method,
          url,
        });
        const internal = new InternalError();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(internal.toJSON()));
      }
    } finally {
      log('debug', 'Request', { method, url, status: res.statusCode, ms: Date.now() - startMs });
    }
  });

  // Prevent server from hanging on keep-alive connections during shutdown
  server.keepAliveTimeout = 5000;

  return {
    router,
    server,
    start(port: number, host: string): Promise<void> {
      return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          const bound = typeof addr === 'string' ? addr : `${host}:${(addr as any).port}`;
          log('info', `ClaudeAPI listening on ${bound}`);
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
