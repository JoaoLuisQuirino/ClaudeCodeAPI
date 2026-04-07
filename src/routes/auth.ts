import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, execSync, ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
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
  proc: ChildProcess;
  createdAt: number;
  status: 'pending' | 'awaiting_code' | 'completed' | 'expired' | 'error';
  authUrl?: string;
  accessToken?: string;
  userHash?: string;
  error?: string;
}

const pendingLogins = new Map<string, PendingLogin>();

// Cleanup expired logins every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
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

  // Spawn claude auth login with stdin pipe (to send the auth code later)
  const proc = spawn(config.claudeBinary, ['auth', 'login'], {
    env: {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      DISPLAY: '',
      BROWSER: 'echo',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

  // Wait for URL to appear in output (max 15s)
  const urlPromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for auth URL')), 15000);
    const check = setInterval(() => {
      const urlMatch = stdout.match(/(https:\/\/claude\.com\/[^\s]+)/);
      if (urlMatch) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve(urlMatch[1]);
      }
    }, 200);
  });

  let authUrl: string;
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
    proc,
    createdAt: Date.now(),
    status: 'awaiting_code',
    authUrl,
  };
  pendingLogins.set(loginId, login);

  // Auto-cleanup after 10 minutes
  setTimeout(async () => {
    proc.kill();
    if (login.status === 'awaiting_code') login.status = 'expired';
    try { await rm(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
  }, 10 * 60 * 1000);

  sendJSON(res, 200, {
    login_id: loginId,
    auth_url: authUrl,
    message: 'Open auth_url in browser, authorize, then POST the auth code to /auth/callback.',
    expires_in_seconds: 600,
  });
}

// ── POST /auth/callback (receive auth code from client) ──────────

export async function authCallbackHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody<{ login_id: string; code: string }>(req);

  if (!body.login_id || !body.code) {
    throw new BadRequestError('login_id and code are required');
  }

  const login = pendingLogins.get(body.login_id);
  if (!login) {
    sendJSON(res, 404, { status: 'not_found', message: 'Login session not found or expired' });
    return;
  }

  if (login.status !== 'awaiting_code') {
    sendJSON(res, 400, { status: login.status, message: `Login is ${login.status}, cannot accept code` });
    return;
  }

  login.status = 'pending';

  log('info', 'Auth code received, exchanging...', { loginId: body.login_id });

  // Sanitize code to prevent shell injection
  const safeCode = body.code.replace(/[^a-zA-Z0-9_#\-]/g, '');
  if (safeCode !== body.code) {
    login.status = 'error';
    login.error = 'Invalid characters in auth code';
    sendJSON(res, 400, { status: 'error', message: 'Invalid auth code format' });
    return;
  }

  // Exchange the code via shell pipe: echo "code" | claude auth login
  // This spawns a NEW process (different code_challenge), but the pipe approach
  // works reliably on Linux. On Windows, the original process handles it.
  // We try both: pipe to original process, then shell fallback.
  try {
    // Try 1: pipe to the original process (works on Linux)
    login.proc.stdin?.write(safeCode + '\n');
    login.proc.stdin?.end();

    // Try 2: shell fallback after a delay (works everywhere)
    const fallbackTimer = setTimeout(() => {
      try {
        login.proc.kill();
        execSync(`echo "${safeCode}" | ${config.claudeBinary} auth login`, {
          env: { ...process.env, BROWSER: 'echo', DISPLAY: '' },
          timeout: 15_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch { /* fallback failed — check credentials anyway */ }
      checkCredentials();
    }, 5000);

    // Watch for original process to complete
    login.proc.on('close', () => {
      clearTimeout(fallbackTimer);
      checkCredentials();
    });

    // Also set a hard timeout
    setTimeout(() => {
      clearTimeout(fallbackTimer);
      if (login.status === 'pending') {
        login.proc.kill();
        checkCredentials();
      }
    }, 20_000);
  } catch (err) {
    login.status = 'error';
    login.error = err instanceof Error ? err.message : String(err);
  }

  async function checkCredentials() {
    if (!login) return;
    const realHome = process.env.USERPROFILE || process.env.HOME || '';
    const possiblePaths = [
      login.credPath,
      join(realHome, '.claude', '.credentials.json'),
    ];

    for (const credPath of possiblePaths) {
      if (!existsSync(credPath)) continue;
      try {
        const raw = await readFile(credPath, 'utf-8');
        const creds = JSON.parse(raw);
        const token = creds.claudeAiOauth?.accessToken;
        if (token) {
          await writeFullCredentials(creds);
          login.status = 'completed';
          login.accessToken = token;
          login.userHash = hashToken(token);
          log('info', 'OAuth login completed', { loginId: body.login_id, userHash: login.userHash, credPath });
          return;
        }
      } catch { /* can't read this path */ }
    }

    if (login.status === 'pending') {
      login.status = 'error';
      login.error = 'No credentials found after login';
    }
  }

  sendJSON(res, 202, {
    status: 'processing',
    message: 'Code received. Poll GET /auth/status/:login_id for the result.',
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
    sendJSON(res, 200, {
      status: 'completed',
      access_token: login.accessToken,
      user_hash: login.userHash,
      message: 'Use access_token as Bearer token for API requests.',
    });
    pendingLogins.delete(loginId);
    return;
  }

  if (login.status === 'expired') {
    sendJSON(res, 410, { status: 'expired', message: 'Login session expired. Start a new one.' });
    pendingLogins.delete(loginId);
    return;
  }

  if (login.status === 'error') {
    sendJSON(res, 500, { status: 'error', message: login.error || 'Unknown error during login' });
    pendingLogins.delete(loginId);
    return;
  }

  sendJSON(res, 202, {
    status: login.status,
    message: login.status === 'awaiting_code'
      ? 'Waiting for auth code. POST it to /auth/callback.'
      : 'Processing credentials...',
  });
}
