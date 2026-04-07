import cluster from 'node:cluster';
import { execSync } from 'node:child_process';
import { config } from './config.js';
import { log } from './logger.js';

// ── Startup validation ────────────────────────────────────────────

function validateStartup(): void {
  // Check claude binary is reachable (skip in test mode)
  if (process.env.NODE_ENV !== 'test' && !config.claudePrependArgs.length) {
    try {
      execSync(`${config.claudeBinary} --version`, { stdio: 'ignore', timeout: 5000 });
    } catch {
      log('warn', `Claude binary "${config.claudeBinary}" not found or not responding. Requests will fail until it is available.`);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────

if (config.clusterEnabled && cluster.isPrimary) {
  validateStartup();
  const { startCluster } = await import('./cluster.js');
  startCluster();
} else {
  if (!config.clusterEnabled) validateStartup();

  const { createApp } = await import('./server.js');
  const app = createApp();

  // Start file cleanup cron
  const { startFileCleanup } = await import('./file-cleanup.js');
  startFileCleanup();

  app.start(config.port, config.host).catch((err) => {
    log('error', 'Failed to start server', { error: err.message });
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    log('info', `Worker received ${signal}, shutting down`);
    app.close().then(() => {
      log('info', 'Server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
