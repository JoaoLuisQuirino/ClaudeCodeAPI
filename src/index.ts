import cluster from 'node:cluster';
import { config } from './config.js';
import { log } from './logger.js';

if (config.clusterEnabled && cluster.isPrimary) {
  // Primary: fork workers
  const { startCluster } = await import('./cluster.js');
  startCluster();
} else {
  // Worker (or single-process mode): start server
  const { createApp } = await import('./server.js');
  const app = createApp();

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
