import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractToken } from '../credentials.js';
import { hashToken } from '../hash.js';
import { sendJSON } from '../sse.js';
import { getSessionsForUser, deleteSession, getSession } from '../sessions.js';
import { NotFoundError } from '../errors.js';

export async function listSessionsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = extractToken(req.headers.authorization, req.headers['x-api-key'] as string | undefined);
  const userHash = hashToken(token);
  const sessions = getSessionsForUser(userHash);

  sendJSON(res, 200, {
    sessions: sessions.map(s => ({
      session_id: s.sessionId,
      model: s.model,
      status: s.status,
      created_at: new Date(s.createdAt).toISOString(),
      last_active_at: new Date(s.lastActiveAt).toISOString(),
    })),
  });
}

export async function deleteSessionHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const token = extractToken(req.headers.authorization, req.headers['x-api-key'] as string | undefined);
  const userHash = hashToken(token);
  const sessionId = params.id;

  const session = getSession(sessionId);
  if (!session || session.userHash !== userHash) {
    throw new NotFoundError('Session not found');
  }

  deleteSession(sessionId);
  sendJSON(res, 200, { deleted: true, session_id: sessionId });
}
