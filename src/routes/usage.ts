import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractToken } from '../credentials.js';
import { hashToken } from '../hash.js';
import { sendJSON } from '../sse.js';
import { getUsageForUser } from '../db.js';

export async function usageHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = extractToken(req.headers.authorization, req.headers['x-api-key'] as string | undefined);
  const userHash = hashToken(token);

  // Parse ?limit=N from query string
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 50), 500);

  const summary = getUsageForUser(userHash, limit);
  sendJSON(res, 200, summary);
}
