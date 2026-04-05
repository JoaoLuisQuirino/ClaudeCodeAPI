/**
 * PostgreSQL adapter — drop-in replacement for db.ts when scaling to multi-node.
 *
 * Setup:
 *   1. npm install pg
 *   2. Set DB_TYPE=postgres and DATABASE_URL in env
 *   3. Change imports from './db.js' to './db-postgres.js' (or use a factory)
 *
 * This file is NOT imported by default. It's a ready-to-use adapter
 * for when you outgrow SQLite on a single node.
 */

import { log } from './logger.js';

// Dynamic import to avoid requiring pg at startup
let _pool: any = null;

async function getPool() {
  if (_pool) return _pool;

  const pgModule = await import('pg').catch(() => {
    throw new Error('pg package not installed. Run: npm install pg');
  });

  const Pool = pgModule.default?.Pool || pgModule.Pool;
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
  });

  // Run migrations
  const client = await _pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS usage_log (
        id SERIAL PRIMARY KEY,
        user_hash TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        session_id TEXT,
        status TEXT DEFAULT 'success',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_hash);
      CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_active_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_hash);
    `);
    log('info', 'PostgreSQL migrations complete');
  } finally {
    client.release();
  }

  return _pool;
}

// ── Usage ─────────────────────────────────────────────────────────

export interface UsageEntry {
  userHash: string;
  endpoint: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  sessionId?: string;
  status?: string;
}

export async function recordUsage(entry: UsageEntry): Promise<void> {
  try {
    const pool = await getPool();
    await pool.query(
      `INSERT INTO usage_log (user_hash, endpoint, model, input_tokens, output_tokens, cost_usd, duration_ms, session_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [entry.userHash, entry.endpoint, entry.model, entry.inputTokens, entry.outputTokens, entry.costUsd, entry.durationMs, entry.sessionId || null, entry.status || 'success'],
    );
  } catch (err) {
    log('error', 'PG: Failed to record usage', { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function getUsageForUser(userHash: string, limit = 50) {
  const pool = await getPool();

  const totals = await pool.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(input_tokens),0) as inp, COALESCE(SUM(output_tokens),0) as out, COALESCE(SUM(cost_usd),0) as cost
     FROM usage_log WHERE user_hash = $1`,
    [userHash],
  );
  const t = totals.rows[0];

  const byModel = await pool.query(
    `SELECT model, COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens, COALESCE(SUM(cost_usd),0) as cost_usd
     FROM usage_log WHERE user_hash = $1 GROUP BY model`,
    [userHash],
  );

  const recent = await pool.query(
    `SELECT endpoint, model, input_tokens, output_tokens, cost_usd, duration_ms, created_at
     FROM usage_log WHERE user_hash = $1 ORDER BY id DESC LIMIT $2`,
    [userHash, limit],
  );

  return {
    totalRequests: Number(t.cnt),
    totalInputTokens: Number(t.inp),
    totalOutputTokens: Number(t.out),
    totalCostUsd: Number(t.cost),
    byModel: byModel.rows,
    recentRequests: recent.rows,
  };
}

// ── Sessions ──────────────────────────────────────────────────────

export async function dbSaveSession(sessionId: string, userHash: string, model: string): Promise<void> {
  try {
    const pool = await getPool();
    await pool.query(
      `INSERT INTO sessions (session_id, user_hash, model) VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO UPDATE SET model = $3, status = 'active', last_active_at = NOW()`,
      [sessionId, userHash, model],
    );
  } catch (err) {
    log('error', 'PG: Failed to save session', { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
