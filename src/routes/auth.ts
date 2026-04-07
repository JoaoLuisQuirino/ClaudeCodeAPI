import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseJsonBody } from '../body-parser.js';
import { writeFullCredentials } from '../credentials.js';
import { sendJSON } from '../sse.js';
import { BadRequestError } from '../errors.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { hashToken } from '../hash.js';

// ── Pending login sessions ────────────────────────────────────────

interface PendingLogin {
  loginId: string;
  tempHome: string;
  credPath: string;
  createdAt: number;
  status: 'pending' | 'completed' | 'expired';
  accessToken?: string;
  userHash?: string;
}

const pendingLogins = new Map<string, PendingLogin>();

// Cleanup expired logins every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000; // 10 min expiry
  for (const [id, login] of pendingLogins) {
    if (login.createdAt < cutoff) pendingLogins.delete(id);
  }
}, 5 * 60 * 1000).unref();

// ── POST /auth/setup (manual credentials upload) ─────────────────

export async function authSetupHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody<Record<string, unknown>>(req);

  if (!body.claudeAiOauth || typeof body.claudeAiOauth !== 'object') {
    throw new BadRequestError('Request body must contain claudeAiOauth object. Send the contents of your ~/.claude/.credentials.json');
  }

  const { userHash } = await writeFullCredentials(body);

  sendJSON(res, 200, {
    status: 'ok',
    message: 'Credentials stored. Use your accessToken as Bearer token for API requests.',
    userHash,
  });
}

// ── POST /auth/login (start OAuth flow) ───────────────────────────

export async function authLoginHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const loginId = randomUUID();
  const tempHome = join(config.dataDir, 'auth-pending', loginId);
  const claudeDir = join(tempHome, '.claude');
  const credPath = join(claudeDir, '.credentials.json');

  await mkdir(claudeDir, { recursive: true });

  // Spawn claude auth login with custom HOME
  const proc = spawn(config.claudeBinary, ['auth', 'login'], {
    env: {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      DISPLAY: '',
      BROWSER: 'echo', // Print URL instead of opening browser
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let authUrl = '';

  proc.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  // Wait for URL to appear in output (max 10s)
  const urlPromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for auth URL')), 10000);

    const check = setInterval(() => {
      // Look for the auth URL in stdout
      const urlMatch = stdout.match(/(https:\/\/claude\.com\/[^\s]+)/);
      if (urlMatch) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve(urlMatch[1]);
      }
    }, 200);
  });

  try {
    authUrl = await urlPromise;
  } catch {
    proc.kill();
    throw new BadRequestError('Failed to generate login URL. Is the claude binary available?');
  }

  // Track this login session
  const login: PendingLogin = {
    loginId,
    tempHome,
    credPath,
    createdAt: Date.now(),
    status: 'pending',
  };
  pendingLogins.set(loginId, login);

  // Background: watch for credentials to appear
  const watcher = setInterval(async () => {
    if (existsSync(credPath)) {
      clearInterval(watcher);
      try {
        const raw = await readFile(credPath, 'utf-8');
        const creds = JSON.parse(raw);
        const token = creds.claudeAiOauth?.accessToken;
        if (token) {
          // Move credentials to the real user directory
          await writeFullCredentials(creds);
          login.status = 'completed';
          login.accessToken = token;
          login.userHash = hashToken(token);
          log('info', 'OAuth login completed', { loginId, userHash: login.userHash });
        }
      } catch (err) {
        log('error', 'Failed to process OAuth credentials', { loginId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }, 1000);

  // Auto-cleanup after 10 minutes (process + temp dir on disk)
  setTimeout(async () => {
    clearInterval(watcher);
    proc.kill();
    if (login.status === 'pending') login.status = 'expired';
    try {
      const { rm } = await import('node:fs/promises');
      await rm(tempHome, { recursive: true, force: true });
    } catch { /* best effort cleanup */ }
  }, 10 * 60 * 1000);

  sendJSON(res, 200, {
    login_id: loginId,
    auth_url: authUrl,
    message: 'Open auth_url in your browser and authorize. Then poll GET /auth/status/:login_id for the result.',
    expires_in_seconds: 600,
  });
}

// ── GET /auth/status/:login_id (poll for completion) ──────────────

export async function authStatusHandler(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const loginId = params.login_id;
  const login = pendingLogins.get(loginId);

  if (!login) {
    sendJSON(res, 404, { status: 'not_found', message: 'Login session not found or expired' });
    return;
  }

  if (login.status === 'completed') {
    // Return the access token — user will use this as Bearer for future requests
    sendJSON(res, 200, {
      status: 'completed',
      access_token: login.accessToken,
      user_hash: login.userHash,
      message: 'Use access_token as Bearer token for API requests.',
    });
    // Cleanup
    pendingLogins.delete(loginId);
    return;
  }

  if (login.status === 'expired') {
    sendJSON(res, 410, { status: 'expired', message: 'Login session expired. Start a new one.' });
    pendingLogins.delete(loginId);
    return;
  }

  sendJSON(res, 202, {
    status: 'pending',
    message: 'Waiting for authorization. Open the auth_url in your browser.',
  });
}
