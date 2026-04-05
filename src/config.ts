import { join } from 'node:path';

function int(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int(process.env.PORT, 3456),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || join(process.cwd(), 'data'),

  // Claude process limits
  maxConcurrentGlobal: int(process.env.MAX_CONCURRENT, 8),
  maxConcurrentPerUser: int(process.env.MAX_CONCURRENT_PER_USER, 3),
  processTimeoutMs: int(process.env.PROCESS_TIMEOUT_MS, 5 * 60 * 1000),

  // Queue
  maxQueueSize: int(process.env.MAX_QUEUE_SIZE, 50),
  queueTimeoutMs: int(process.env.QUEUE_TIMEOUT_MS, 60 * 1000), // 60s max wait

  // Cluster
  clusterEnabled: process.env.CLUSTER_ENABLED === 'true',
  clusterWorkers: int(process.env.CLUSTER_WORKERS, 0), // 0 = auto (CPU count)

  // Files
  maxFileSizeBytes: int(process.env.MAX_FILE_SIZE, 100 * 1024 * 1024),
  fileCleanupHours: int(process.env.FILE_CLEANUP_HOURS, 24),

  // Claude binary
  claudeBinary: process.env.CLAUDE_BINARY || 'claude',
  /** Extra args prepended before -p (e.g. ['path/to/mock.mjs'] for testing with node) */
  claudePrependArgs: [] as string[],

  // Default model
  defaultModel: process.env.DEFAULT_MODEL || 'sonnet',

  // Logging
  logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
};
