import { queue } from './queue.js';
import { log } from './logger.js';
import { config } from './config.js';

let timer: NodeJS.Timeout | null = null;

/**
 * Evaluate the queue stats and log scale recommendations.
 */
function evaluate(): void {
  const stats = queue.stats;
  const utilization = stats.maxSlots > 0 ? stats.activeSlots / stats.maxSlots : 0;
  const queuePressure = stats.maxQueueLength > 0 ? stats.queueLength / stats.maxQueueLength : 0;

  log('debug', 'Watchdog tick', {
    activeSlots: stats.activeSlots,
    maxSlots: stats.maxSlots,
    queueLength: stats.queueLength,
    utilization: Math.round(utilization * 100),
    queuePressure: Math.round(queuePressure * 100),
  });

  if (utilization >= 0.9 || queuePressure >= 0.5) {
    log('warn', 'SCALE-UP recommended: high load', {
      utilization: Math.round(utilization * 100),
      queuePressure: Math.round(queuePressure * 100),
      activeSlots: stats.activeSlots,
      queueLength: stats.queueLength,
    });
    notifyWebhook('scale-up', stats).catch(() => {});
  } else if (utilization <= 0.1 && stats.queueLength === 0) {
    log('info', 'SCALE-DOWN possible: low load', {
      utilization: Math.round(utilization * 100),
      activeSlots: stats.activeSlots,
    });
    notifyWebhook('scale-down', stats).catch(() => {});
  }
}

/**
 * POST to an optional webhook URL with scale recommendations.
 */
async function notifyWebhook(
  recommendation: 'scale-up' | 'scale-down',
  stats: typeof queue.stats,
): Promise<void> {
  const url = process.env.WATCHDOG_WEBHOOK_URL;
  if (!url) return;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recommendation,
        stats,
        timestamp: new Date().toISOString(),
        host: config.host,
        port: config.port,
      }),
      signal: AbortSignal.timeout(5000),
    });
    log('debug', 'Watchdog webhook sent', { recommendation, status: resp.status });
  } catch (err) {
    log('warn', 'Watchdog webhook failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Start the watchdog monitor. Evaluates queue every 30 seconds.
 */
export function startWatchdog(): NodeJS.Timeout {
  log('info', 'Watchdog started', { intervalMs: 30_000 });
  const t = setInterval(evaluate, 30_000);
  timer = t;
  return t;
}

/**
 * Stop the watchdog monitor.
 */
export function stopWatchdog(t?: NodeJS.Timeout): void {
  const handle = t ?? timer;
  if (handle) {
    clearInterval(handle);
    if (handle === timer) timer = null;
  }
}

// Exported for testing
export { evaluate as _evaluate };
