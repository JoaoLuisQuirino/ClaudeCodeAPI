import { existsSync, statfsSync } from 'node:fs';
import { config } from './config.js';
import { queue } from './queue.js';

export interface HealthDetail {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
  process: ProcessMetrics;
  queue: QueueHealth;
  disk: DiskHealth;
  checks: Record<string, boolean>;
}

export interface ProcessMetrics {
  pid: number;
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  external_mb: number;
  cpu_user_ms: number;
  cpu_system_ms: number;
}

export interface QueueHealth {
  activeSlots: number;
  maxSlots: number;
  queueLength: number;
  maxQueueLength: number;
  totalProcessed: number;
  totalRejected: number;
  totalTimedOut: number;
  avgWaitMs: number;
  utilization: number; // 0-1
}

export interface DiskHealth {
  dataDir: string;
  available_mb: number;
  total_mb: number;
  usagePercent: number;
}

export function getProcessMetrics(): ProcessMetrics {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    pid: process.pid,
    rss_mb: Math.round(mem.rss / 1024 / 1024),
    heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    external_mb: Math.round(mem.external / 1024 / 1024),
    cpu_user_ms: Math.round(cpu.user / 1000),
    cpu_system_ms: Math.round(cpu.system / 1000),
  };
}

export function getDiskHealth(): DiskHealth {
  try {
    const stats = statfsSync(config.dataDir);
    const blockSize = stats.bsize;
    const totalBytes = stats.blocks * blockSize;
    const availBytes = stats.bavail * blockSize;
    return {
      dataDir: config.dataDir,
      available_mb: Math.round(availBytes / 1024 / 1024),
      total_mb: Math.round(totalBytes / 1024 / 1024),
      usagePercent: Math.round((1 - availBytes / totalBytes) * 100),
    };
  } catch {
    return { dataDir: config.dataDir, available_mb: -1, total_mb: -1, usagePercent: -1 };
  }
}

export function getQueueHealth(): QueueHealth {
  const stats = queue.stats;
  return {
    ...stats,
    utilization: stats.maxSlots > 0 ? Math.round((stats.activeSlots / stats.maxSlots) * 100) / 100 : 0,
  };
}

export function getFullHealth(): HealthDetail {
  const proc = getProcessMetrics();
  const queueHealth = getQueueHealth();
  const disk = getDiskHealth();

  const checks: Record<string, boolean> = {
    memory_ok: proc.rss_mb < 1024, // Under 1GB
    disk_ok: disk.usagePercent < 90 || disk.usagePercent < 0,
    queue_ok: queueHealth.queueLength < queueHealth.maxQueueLength * 0.8,
    data_dir_exists: existsSync(config.dataDir),
  };

  const allOk = Object.values(checks).every(Boolean);
  const anyFailed = Object.values(checks).some(v => !v);

  return {
    status: allOk ? 'healthy' : anyFailed ? 'degraded' : 'unhealthy',
    version: '0.1.0',
    uptime: Math.floor(process.uptime()),
    process: proc,
    queue: queueHealth,
    disk,
    checks,
  };
}

/** Liveness: is the process alive? Always true unless shutting down. */
export function isLive(): boolean {
  return true; // If this code runs, we're alive
}

/** Readiness: can we accept new requests? */
export function isReady(): boolean {
  const q = queue.stats;
  // Not ready if queue is completely full
  return q.queueLength < q.maxQueueLength;
}
