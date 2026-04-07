/**
 * Session tracker with write-through persistence.
 * In-memory Map for fast reads + SQLite for persistence across restarts.
 */

import {
  dbSaveSession, dbUpdateSession,
  dbGetSessionsForUser, dbDeleteSession, dbLoadAllSessions,
  dbSaveWorkspaceMap, dbLoadAllWorkspaceMaps,
} from './db.js';
import { log } from './logger.js';

export interface SessionInfo {
  sessionId: string;
  userHash: string;
  model: string;
  createdAt: number;
  lastActiveAt: number;
  status: 'active' | 'completed' | 'error';
}

const sessions = new Map<string, SessionInfo>();
let loaded = false;

/** Load sessions and workspace map from DB on first access. */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const rows = dbLoadAllSessions();
    for (const row of rows) {
      sessions.set(row.session_id, {
        sessionId: row.session_id,
        userHash: row.user_hash,
        model: row.model,
        createdAt: new Date(row.created_at).getTime(),
        lastActiveAt: new Date(row.last_active_at).getTime(),
        status: row.status as 'active' | 'completed' | 'error',
      });
    }
    // Load workspace mappings (bidirectional)
    const maps = dbLoadAllWorkspaceMaps();
    for (const m of maps) {
      workspaceMap.set(m.claude_session_id, m.workspace_session_id);
      claudeIdMap.set(m.workspace_session_id, m.claude_session_id);
    }
  } catch {
    // DB not ready yet — will work with in-memory only
  }
}

export function trackSession(sessionId: string, userHash: string, model: string): void {
  ensureLoaded();
  const now = Date.now();
  sessions.set(sessionId, {
    sessionId, userHash, model,
    createdAt: now, lastActiveAt: now, status: 'active',
  });
  dbSaveSession(sessionId, userHash, model);
}

export function touchSession(sessionId: string): void {
  ensureLoaded();
  const s = sessions.get(sessionId);
  if (s) {
    s.lastActiveAt = Date.now();
    // Don't write to DB on every touch (too frequent during streaming)
  }
}

export function completeSession(sessionId: string, status: 'completed' | 'error' = 'completed'): void {
  ensureLoaded();
  const s = sessions.get(sessionId);
  if (s) {
    s.status = status;
    s.lastActiveAt = Date.now();
  }
  dbUpdateSession(sessionId, { status });
}

/** Maps Claude's session_id → our workspace session_id */
const workspaceMap = new Map<string, string>();
/** Maps our workspace session_id → Claude's real session_id (for --continue) */
const claudeIdMap = new Map<string, string>();

/**
 * Map a client session_id to Claude's real session_id.
 * Always updates to the LATEST Claude ID — each --resume creates a new session
 * with accumulated history, so we need the newest ID for the next --resume.
 */
export function renameSession(clientId: string, claudeId: string): void {
  ensureLoaded();
  if (clientId === claudeId) return;
  // Clean up old mapping if exists
  const oldClaudeId = claudeIdMap.get(clientId);
  if (oldClaudeId) workspaceMap.delete(oldClaudeId);
  // Always update to latest
  workspaceMap.set(claudeId, clientId);
  claudeIdMap.set(clientId, claudeId);
  dbSaveWorkspaceMap(claudeId, clientId);
  log('info', 'Session mapped', { clientId, claudeId, previousClaudeId: oldClaudeId || '(first)' });
}

/** Get Claude's real session_id for --resume.
 *  The client may send any ID — we need Claude's actual ID. */
export function getClaudeSessionId(sessionId: string): string | undefined {
  // Direct: client sent our workspace ID → look up Claude's ID
  const direct = claudeIdMap.get(sessionId);
  if (direct) return direct;
  // Client sent Claude's ID directly → use as-is
  if (workspaceMap.has(sessionId)) return sessionId;
  // Unknown ID — might be client's own ID. Check if any session has this as workspace.
  // Walk the workspace map to find if this ID was stored as a workspace
  for (const [claudeId, wsId] of workspaceMap) {
    if (wsId === sessionId) return claudeId;
  }
  return undefined;
}

export function getSession(sessionId: string): SessionInfo | undefined {
  ensureLoaded();
  return sessions.get(sessionId);
}

export function getSessionsForUser(userHash: string): SessionInfo[] {
  ensureLoaded();
  // Try in-memory first
  const result: SessionInfo[] = [];
  for (const s of sessions.values()) {
    if (s.userHash === userHash) result.push(s);
  }
  if (result.length > 0) return result;

  // Fallback to DB (in case sessions were from a previous process)
  const dbRows = dbGetSessionsForUser(userHash);
  for (const row of dbRows) {
    const info: SessionInfo = {
      sessionId: row.session_id,
      userHash: row.user_hash,
      model: row.model,
      createdAt: new Date(row.created_at).getTime(),
      lastActiveAt: new Date(row.last_active_at).getTime(),
      status: row.status as 'active' | 'completed' | 'error',
    };
    sessions.set(row.session_id, info);
    result.push(info);
  }
  return result;
}

export function deleteSession(sessionId: string): boolean {
  ensureLoaded();
  dbDeleteSession(sessionId);
  return sessions.delete(sessionId);
}

export function getAllSessions(): SessionInfo[] {
  ensureLoaded();
  return Array.from(sessions.values());
}

export function cleanupSessions(maxAgeMs: number): number {
  ensureLoaded();
  const cutoff = Date.now() - maxAgeMs;
  let cleaned = 0;
  for (const [id, s] of sessions) {
    if (s.lastActiveAt < cutoff) {
      sessions.delete(id);
      dbDeleteSession(id);
      // Clean up workspace map entries for this session
      const claudeId = claudeIdMap.get(id);
      if (claudeId) {
        claudeIdMap.delete(id);
        workspaceMap.delete(claudeId);
      }
      cleaned++;
    }
  }
  return cleaned;
}

// ── Auto-cleanup: run every 30 minutes ────────────────────────────
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const sessionCleanupTimer = setInterval(() => {
  const cleaned = cleanupSessions(SESSION_MAX_AGE_MS);
  if (cleaned > 0) {
    log('info', `Session cleanup: removed ${cleaned} stale sessions`);
  }
}, 30 * 60 * 1000); // every 30 min

sessionCleanupTimer.unref(); // don't prevent process exit
