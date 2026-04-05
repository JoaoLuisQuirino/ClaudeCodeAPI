/**
 * Session tracker with write-through persistence.
 * In-memory Map for fast reads + SQLite for persistence across restarts.
 */

import {
  dbSaveSession, dbUpdateSession, dbRenameSession,
  dbGetSessionsForUser, dbDeleteSession, dbLoadAllSessions,
} from './db.js';

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

/** Load sessions from DB on first access. */
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

export function renameSession(oldId: string, newId: string): void {
  ensureLoaded();
  const s = sessions.get(oldId);
  if (s && oldId !== newId) {
    sessions.delete(oldId);
    s.sessionId = newId;
    sessions.set(newId, s);
    dbRenameSession(oldId, newId);
  }
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
      cleaned++;
    }
  }
  return cleaned;
}
