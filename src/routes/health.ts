import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJSON } from '../sse.js';
import { getFullHealth, isLive, isReady } from '../monitoring.js';

/** GET /health — full health detail with queue stats, memory, disk. */
export async function healthHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const health = getFullHealth();
  const code = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
  sendJSON(res, code, health);
}

/** GET /health/live — K8s liveness probe. 200 if process is alive. */
export async function liveHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJSON(res, isLive() ? 200 : 503, { status: isLive() ? 'alive' : 'dead' });
}

/** GET /health/ready — K8s readiness probe. 200 if can accept requests. */
export async function readyHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJSON(res, isReady() ? 200 : 503, { status: isReady() ? 'ready' : 'not_ready' });
}
