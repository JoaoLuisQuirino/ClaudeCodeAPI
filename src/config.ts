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
  maxConcurrentPerUser: int(process.env.MAX_CONCURRENT_PER_USER, 0), // 0 = no per-user limit
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

  // Security
  allowedModels: new Set((process.env.ALLOWED_MODELS || 'sonnet,opus,haiku,claude-sonnet-4-6,claude-opus-4-6,claude-haiku-4-5,claude-sonnet-4-5,claude-opus-4-5').split(',')),
  corsOrigins: process.env.CORS_ORIGINS || '*',

  // Logging
  logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',

  // Per-user disk quota
  maxUserDiskBytes: int(process.env.MAX_USER_DISK_BYTES, 500 * 1024 * 1024),

  // Docker isolation
  dockerIsolation: process.env.DOCKER_ISOLATION === 'true',
  dockerImage: process.env.DOCKER_IMAGE || 'claudecodeapi/sandbox',
  dockerMemory: process.env.DOCKER_MEMORY || '512m',
  dockerCpus: process.env.DOCKER_CPUS || '1',

  // Proxy trust
  trustProxy: process.env.TRUST_PROXY === 'true',
};

// ── Config bounds validation ──────────────────────────────────────
config.maxConcurrentGlobal = Math.max(1, Math.min(200, config.maxConcurrentGlobal));
config.maxConcurrentPerUser = Math.max(1, Math.min(50, config.maxConcurrentPerUser));
config.maxQueueSize = Math.max(1, Math.min(1000, config.maxQueueSize));
config.processTimeoutMs = config.processTimeoutMs === 0 ? 0 : Math.max(10_000, Math.min(30 * 60_000, config.processTimeoutMs));
