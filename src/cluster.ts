import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { config } from './config.js';
import { log } from './logger.js';

/**
 * Cluster entry point.
 * Primary forks workers, each worker runs the HTTP server.
 * Workers share the port via OS round-robin.
 */
export function startCluster(): void {
  const numWorkers = config.clusterWorkers > 0
    ? config.clusterWorkers
    : Math.max(1, availableParallelism() - 1); // Leave 1 core for OS

  // Divide queue slots across workers
  const slotsPerWorker = Math.max(1, Math.ceil(config.maxConcurrentGlobal / numWorkers));
  const perUserPerWorker = Math.max(1, Math.ceil(config.maxConcurrentPerUser / numWorkers));

  log('info', `Cluster starting: ${numWorkers} workers, ${slotsPerWorker} slots/worker`, {
    totalSlots: config.maxConcurrentGlobal,
    slotsPerWorker,
    perUserPerWorker,
  });

  // Fork workers
  for (let i = 0; i < numWorkers; i++) {
    const worker = cluster.fork({
      // Pass per-worker limits via env
      MAX_CONCURRENT: String(slotsPerWorker),
      MAX_CONCURRENT_PER_USER: String(perUserPerWorker),
      CLUSTER_WORKER_ID: String(i),
    });
    log('info', `Worker ${worker.process.pid} started (${i + 1}/${numWorkers})`);
  }

  // Auto-restart dead workers
  cluster.on('exit', (worker, code, signal) => {
    const reason = signal || `code ${code}`;
    log('warn', `Worker ${worker.process.pid} died (${reason}), restarting...`);
    const newWorker = cluster.fork({
      MAX_CONCURRENT: String(slotsPerWorker),
      MAX_CONCURRENT_PER_USER: String(perUserPerWorker),
    });
    log('info', `Replacement worker ${newWorker.process.pid} started`);
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `Primary received ${signal}, shutting down workers...`);

    for (const id in cluster.workers) {
      cluster.workers[id]?.process.kill('SIGTERM');
    }

    // Force exit after 15s
    setTimeout(() => {
      log('warn', 'Force exiting primary after timeout');
      process.exit(1);
    }, 15_000).unref();

    // Exit when all workers are gone
    let remaining = Object.keys(cluster.workers ?? {}).length;
    cluster.on('exit', () => {
      remaining--;
      if (remaining <= 0) {
        log('info', 'All workers stopped');
        process.exit(0);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
