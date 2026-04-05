import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { config } from './config.js';
import { log } from './logger.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(config.dataDir, { recursive: true });
  const dbPath = join(config.dataDir, 'claudeapi.db');

  db = new Database(dbPath);

  // Performance: WAL mode, synchronous normal
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  migrate(db);
  log('info', 'SQLite database initialized', { path: dbPath });

  return db;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_hash TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      session_id TEXT,
      status TEXT DEFAULT 'success',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_hash);
    CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      user_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      last_active_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_hash);
  `);
}

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

const insertStmt = () => getDb().prepare(`
  INSERT INTO usage_log (user_hash, endpoint, model, input_tokens, output_tokens, cost_usd, duration_ms, session_id, status)
  VALUES (@userHash, @endpoint, @model, @inputTokens, @outputTokens, @costUsd, @durationMs, @sessionId, @status)
`);

let _insertStmt: Database.Statement | null = null;

export function recordUsage(entry: UsageEntry): void {
  try {
    if (!_insertStmt) _insertStmt = insertStmt();
    _insertStmt.run({
      userHash: entry.userHash,
      endpoint: entry.endpoint,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd: entry.costUsd,
      durationMs: entry.durationMs,
      sessionId: entry.sessionId || null,
      status: entry.status || 'success',
    });
  } catch (err) {
    log('error', 'Failed to record usage', { error: err instanceof Error ? err.message : String(err) });
  }
}

export interface UsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byModel: Array<{ model: string; requests: number; input_tokens: number; output_tokens: number; cost_usd: number }>;
  recentRequests: Array<{
    endpoint: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    duration_ms: number;
    created_at: string;
  }>;
}

export function getUsageForUser(userHash: string, limit = 50): UsageSummary {
  const database = getDb();

  const totals = database.prepare(`
    SELECT COUNT(*) as cnt, COALESCE(SUM(input_tokens),0) as inp, COALESCE(SUM(output_tokens),0) as out, COALESCE(SUM(cost_usd),0) as cost
    FROM usage_log WHERE user_hash = ?
  `).get(userHash) as { cnt: number; inp: number; out: number; cost: number };

  const byModel = database.prepare(`
    SELECT model, COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens, COALESCE(SUM(cost_usd),0) as cost_usd
    FROM usage_log WHERE user_hash = ? GROUP BY model
  `).all(userHash) as Array<{ model: string; requests: number; input_tokens: number; output_tokens: number; cost_usd: number }>;

  const recent = database.prepare(`
    SELECT endpoint, model, input_tokens, output_tokens, cost_usd, duration_ms, created_at
    FROM usage_log WHERE user_hash = ? ORDER BY id DESC LIMIT ?
  `).all(userHash, limit) as Array<{
    endpoint: string; model: string; input_tokens: number; output_tokens: number;
    cost_usd: number; duration_ms: number; created_at: string;
  }>;

  return {
    totalRequests: totals.cnt,
    totalInputTokens: totals.inp,
    totalOutputTokens: totals.out,
    totalCostUsd: totals.cost,
    byModel,
    recentRequests: recent,
  };
}

// ── Session persistence ───────────────────────────────────────────

export interface DbSession {
  session_id: string;
  user_hash: string;
  model: string;
  status: string;
  created_at: string;
  last_active_at: string;
}

export function dbSaveSession(sessionId: string, userHash: string, model: string): void {
  try {
    getDb().prepare(`
      INSERT OR REPLACE INTO sessions (session_id, user_hash, model, status) VALUES (?, ?, ?, 'active')
    `).run(sessionId, userHash, model);
  } catch (err) {
    log('error', 'Failed to save session', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function dbUpdateSession(sessionId: string, updates: { status?: string; lastActiveAt?: boolean }): void {
  try {
    if (updates.status) {
      getDb().prepare(`UPDATE sessions SET status = ?, last_active_at = datetime('now') WHERE session_id = ?`).run(updates.status, sessionId);
    } else if (updates.lastActiveAt) {
      getDb().prepare(`UPDATE sessions SET last_active_at = datetime('now') WHERE session_id = ?`).run(sessionId);
    }
  } catch (err) {
    log('error', 'Failed to update session', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function dbRenameSession(oldId: string, newId: string): void {
  try {
    const database = getDb();
    // Delete any existing entry with the new ID to avoid UNIQUE conflict
    database.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(newId);
    database.prepare(`UPDATE sessions SET session_id = ? WHERE session_id = ?`).run(newId, oldId);
  } catch (err) {
    log('error', 'Failed to rename session', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function dbGetSessionsForUser(userHash: string): DbSession[] {
  try {
    return getDb().prepare(`SELECT * FROM sessions WHERE user_hash = ? ORDER BY last_active_at DESC`).all(userHash) as DbSession[];
  } catch {
    return [];
  }
}

export function dbDeleteSession(sessionId: string): void {
  try {
    getDb().prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
  } catch (err) {
    log('error', 'Failed to delete session', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function dbLoadAllSessions(): DbSession[] {
  try {
    return getDb().prepare(`SELECT * FROM sessions WHERE status = 'active' OR status = 'completed'`).all() as DbSession[];
  } catch {
    return [];
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    _insertStmt = null;
  }
}
