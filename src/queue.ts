import { randomUUID } from 'node:crypto';
import { TooManyRequestsError, GatewayTimeoutError } from './errors.js';
import { config } from './config.js';
import { log } from './logger.js';
import { spawnClaude, type SpawnClaudeOpts, type SpawnResult } from './claude-spawn.js';

// ── Types ─────────────────────────────────────────────────────────

export interface QueueTicket {
  id: string;
  userHash: string;
  acquiredAt: number;
}

export interface QueueStats {
  activeSlots: number;
  maxSlots: number;
  queueLength: number;
  maxQueueLength: number;
  queuedUsers: number;
  totalProcessed: number;
  totalQueued: number;
  totalRejected: number;
  totalTimedOut: number;
  avgWaitMs: number;
}

interface QueueEntry {
  id: string;
  userHash: string;
  enqueuedAt: number;
  resolve: (ticket: QueueTicket) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Request Queue ─────────────────────────────────────────────────

class RequestQueue {
  private activeGlobal = 0;
  private activePerUser = new Map<string, number>();
  private queue: QueueEntry[] = [];

  // Metrics
  private _totalProcessed = 0;
  private _totalQueued = 0;
  private _totalRejected = 0;
  private _totalTimedOut = 0;
  private _waitTimes: number[] = [];

  private get maxSlots(): number { return config.maxConcurrentGlobal; }
  private get maxPerUser(): number { return config.maxConcurrentPerUser; }
  private get maxQueueSize(): number { return config.maxQueueSize; }
  private get queueTimeoutMs(): number { return config.queueTimeoutMs; }

  /** Try to get a slot. Waits in queue if full. Rejects if queue is also full or timeout. */
  acquire(userHash: string): Promise<QueueTicket> {
    // Fast path: slot available
    if (this.canGrant(userHash)) {
      return Promise.resolve(this.grant(userHash));
    }

    // Limit how many requests a single user can have in queue (prevent flooding)
    const userQueued = this.queue.filter(e => e.userHash === userHash).length;
    if (userQueued >= this.maxPerUser * 3) {
      this._totalRejected++;
      return Promise.reject(new TooManyRequestsError('Too many concurrent requests for this user'));
    }

    // Check queue capacity
    if (this.queue.length >= this.maxQueueSize) {
      this._totalRejected++;
      return Promise.reject(new TooManyRequestsError(`Server queue full (${this.maxQueueSize} waiting)`));
    }

    // Enqueue
    this._totalQueued++;
    return new Promise((resolve, reject) => {
      const id = randomUUID().slice(0, 8);
      const timer = setTimeout(() => {
        this.removeFromQueue(id);
        this._totalTimedOut++;
        reject(new GatewayTimeoutError(`Queued for ${this.queueTimeoutMs}ms without getting a slot`));
      }, this.queueTimeoutMs);

      this.queue.push({ id, userHash, enqueuedAt: Date.now(), resolve, reject, timer });
      log('debug', 'Request queued', { userHash, position: this.queue.length, queueId: id });
    });
  }

  /** Release a slot. Grants the next eligible queued request. */
  release(ticket: QueueTicket): void {
    this.activeGlobal = Math.max(0, this.activeGlobal - 1);
    const userCount = this.activePerUser.get(ticket.userHash) ?? 0;
    if (userCount <= 1) {
      this.activePerUser.delete(ticket.userHash);
    } else {
      this.activePerUser.set(ticket.userHash, userCount - 1);
    }

    this._totalProcessed++;

    // Process next eligible request from queue
    this.drainQueue();
  }

  get stats(): QueueStats {
    const uniqueUsers = new Set(this.queue.map(e => e.userHash));
    const avgWait = this._waitTimes.length > 0
      ? this._waitTimes.reduce((a, b) => a + b, 0) / this._waitTimes.length
      : 0;

    return {
      activeSlots: this.activeGlobal,
      maxSlots: this.maxSlots,
      queueLength: this.queue.length,
      maxQueueLength: this.maxQueueSize,
      queuedUsers: uniqueUsers.size,
      totalProcessed: this._totalProcessed,
      totalQueued: this._totalQueued,
      totalRejected: this._totalRejected,
      totalTimedOut: this._totalTimedOut,
      avgWaitMs: Math.round(avgWait),
    };
  }

  getActiveForUser(userHash: string): number {
    return this.activePerUser.get(userHash) ?? 0;
  }

  // ── Private ──

  private canGrant(userHash: string): boolean {
    if (this.activeGlobal >= this.maxSlots) return false;
    const userActive = this.activePerUser.get(userHash) ?? 0;
    if (userActive >= this.maxPerUser) return false;
    return true;
  }

  private grant(userHash: string): QueueTicket {
    this.activeGlobal++;
    this.activePerUser.set(userHash, (this.activePerUser.get(userHash) ?? 0) + 1);
    return { id: randomUUID().slice(0, 8), userHash, acquiredAt: Date.now() };
  }

  private drainQueue(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const entry = this.queue[i];
      if (this.canGrant(entry.userHash)) {
        this.queue.splice(i, 1);
        clearTimeout(entry.timer);
        const waitMs = Date.now() - entry.enqueuedAt;
        this._waitTimes.push(waitMs);
        // Keep only last 100 wait times for avg calculation
        if (this._waitTimes.length > 100) this._waitTimes.shift();
        log('debug', 'Request dequeued', { userHash: entry.userHash, waitMs, queueId: entry.id });
        entry.resolve(this.grant(entry.userHash));
        return; // Grant one at a time, let event loop handle next
      }
    }
  }

  private removeFromQueue(id: string): void {
    const idx = this.queue.findIndex(e => e.id === id);
    if (idx !== -1) {
      clearTimeout(this.queue[idx].timer);
      this.queue.splice(idx, 1);
    }
  }
}

// ── Global instance ───────────────────────────────────────────────

export const queue = new RequestQueue();

// ── Per-session lock ─────────────────────────────────────────────
// Claude Code does NOT support concurrent access to the same session.
// Two processes writing to the same session JSONL = corruption.
// This lock ensures requests for the same session are serialized.

const sessionLocks = new Map<string, Promise<void>>();

async function acquireSessionLock(sessionId: string | undefined): Promise<() => void> {
  if (!sessionId) return () => {}; // new sessions don't need locking

  // Wait for any existing operation on this session
  while (sessionLocks.has(sessionId)) {
    await sessionLocks.get(sessionId);
  }

  // Create a lock that resolves when we release
  let releaseLock: () => void;
  const lockPromise = new Promise<void>(resolve => { releaseLock = resolve; });
  sessionLocks.set(sessionId, lockPromise);

  return () => {
    sessionLocks.delete(sessionId);
    releaseLock!();
  };
}

// ── spawnWithQueue: queue-aware spawn ─────────────────────────────

/**
 * Acquires a queue slot + per-session lock, spawns claude, and
 * auto-releases both when the process closes or cleanup is called.
 *
 * Drop-in replacement for spawnClaude in route handlers.
 */
export async function spawnWithQueue(opts: SpawnClaudeOpts): Promise<SpawnResult> {
  // Per-session lock: serialize requests for the same session
  const releaseSessionLock = await acquireSessionLock(opts.sessionId);

  // Global + per-user concurrency slot
  let ticket: QueueTicket;
  try {
    ticket = await queue.acquire(opts.userHash);
  } catch (err) {
    releaseSessionLock();
    throw err;
  }

  let result: SpawnResult;
  try {
    result = spawnClaude(opts);
  } catch (err) {
    queue.release(ticket);
    releaseSessionLock();
    throw err;
  }

  let released = false;
  const releaseOnce = () => {
    if (!released) {
      released = true;
      queue.release(ticket);
      releaseSessionLock();
    }
  };

  // Auto-release on process close
  result.process.on('close', releaseOnce);

  // Wrap cleanup to also release slot + session lock
  const origCleanup = result.cleanup;
  const wrappedCleanup = () => {
    origCleanup();
    releaseOnce();
  };

  return { process: result.process, cleanup: wrappedCleanup };
}
