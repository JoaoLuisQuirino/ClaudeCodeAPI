import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { parseJsonBody } from '../body-parser.js';
import { extractToken, getUserPaths, writeFullCredentials } from '../credentials.js';
import { sendJSON } from '../sse.js';
import { BadRequestError, UnauthorizedError } from '../errors.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { hashToken } from '../hash.js';

/** Strip ANSI escape codes from PTY output */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
}

// ── Pending login sessions ────────────────────────────────────────

interface PendingLogin {
  loginId: string;
  tempHome: string;
  credPath: string;
  ptyProc: ReturnType<typeof pty.spawn>;
  ptyOutput: string;
  ptyExited: boolean;
  createdAt: number;
  status: 'pending' | 'awaiting_code' | 'completed' | 'expired' | 'error';
  authUrl?: string;
  accessToken?: string;
  userHash?: string;
  expiresAt?: number;
  subscriptionType?: string;
  error?: string;
}

const pendingLogins = new Map<string, PendingLogin>();

// Cleanup expired logins every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, login] of pendingLogins) {
    if (login.createdAt < cutoff) {
      if (!login.ptyExited) login.ptyProc.kill();
      pendingLogins.delete(id);
    }
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

// ── POST /auth/login (start OAuth flow via PTY) ──────────────────

export async function authLoginHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const loginId = randomUUID();
  const tempHome = join(config.dataDir, 'auth-pending', loginId);
  const claudeDir = join(tempHome, '.claude');
  const credPath = join(claudeDir, '.credentials.json');

  await mkdir(claudeDir, { recursive: true });

  // Spawn claude auth login in a pseudo-terminal (CLI reads code from TTY, not stdin)
  const ptyProc = pty.spawn(config.claudeBinary, ['auth', 'login'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 24,
    cwd: tempHome,
    env: {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      DISPLAY: '',
      BROWSER: 'echo',
    },
  });

  // Shared mutable state — accumulated by onData, read by callback handler
  const login: PendingLogin = {
    loginId,
    tempHome,
    credPath,
    ptyProc,
    ptyOutput: '',
    ptyExited: false,
    createdAt: Date.now(),
    status: 'pending',
    authUrl: undefined,
  };

  ptyProc.onData((data: string) => {
    login.ptyOutput += data;
    if (login.ptyOutput.length > 32768) login.ptyOutput = login.ptyOutput.slice(-16384);
  });
  ptyProc.onExit(() => { login.ptyExited = true; });

  // Wait for auth URL to appear in PTY output (max 15s)
  try {
    const authUrl = await new Promise<string>((ok, fail) => {
      const timeout = setTimeout(() => fail(new Error('Timeout waiting for auth URL')), 15000);
      const check = setInterval(() => {
        const clean = stripAnsi(login.ptyOutput);
        const m = clean.match(/(https:\/\/claude\.(ai|com)\/[^\s\r\n]+)/);
        if (m) {
          clearInterval(check);
          clearTimeout(timeout);
          ok(m[1]);
        }
      }, 200);
    });

    login.authUrl = authUrl;
    login.status = 'awaiting_code';
    pendingLogins.set(loginId, login);
  } catch {
    ptyProc.kill();
    throw new BadRequestError('Failed to generate login URL. Is the claude binary available?');
  }

  // Auto-cleanup after 10 minutes
  setTimeout(async () => {
    if (!login.ptyExited) ptyProc.kill();
    if (login.status === 'awaiting_code') login.status = 'expired';
    try { await rm(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
  }, 10 * 60 * 1000);

  sendJSON(res, 200, {
    login_id: loginId,
    auth_url: login.authUrl,
    message: 'Open auth_url in browser, authorize, then POST the auth code to /auth/callback.',
    expires_in_seconds: 600,
  });
}

// ── POST /auth/callback (receive auth code — synchronous) ────────

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

  // Sanitize code to prevent shell injection
  const safeCode = body.code.replace(/[^a-zA-Z0-9_#\-]/g, '');
  if (safeCode !== body.code) {
    login.status = 'error';
    login.error = 'Invalid characters in auth code';
    sendJSON(res, 400, { status: 'error', message: 'Invalid auth code format' });
    return;
  }

  login.status = 'pending';
  log('info', 'Auth code received, writing to PTY...', { loginId: body.login_id });

  // Write code to the pseudo-terminal (simulates user typing + Enter)
  login.ptyProc.write(safeCode + '\r');

  // Wait for the PTY process to exit (timeout 30s)
  if (!login.ptyExited) {
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        if (!login.ptyExited) login.ptyProc.kill();
        done();
      }, 30_000);
      login.ptyProc.onExit(() => { clearTimeout(timer); done(); });
    });
  }

  // Check credentials in all possible locations
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
      if (!token) continue;

      await writeFullCredentials(creds);

      login.status = 'completed';
      login.accessToken = token;
      login.userHash = hashToken(token);
      login.expiresAt = creds.claudeAiOauth?.expiresAt;
      login.subscriptionType = creds.claudeAiOauth?.subscriptionType;

      log('info', 'OAuth login completed', { loginId: body.login_id, userHash: login.userHash, credPath });

      // Clean up temp dir
      rm(login.tempHome, { recursive: true, force: true }).catch(() => {});

      sendJSON(res, 200, {
        status: 'completed',
        access_token: login.accessToken,
        user_hash: login.userHash,
        expires_at: login.expiresAt ?? null,
        subscription_type: login.subscriptionType ?? null,
      });
      pendingLogins.delete(body.login_id);
      return;
    } catch { /* can't read this path, try next */ }
  }

  // No credentials found — report the failure with PTY output
  const ptyOutput = stripAnsi(login.ptyOutput).trim();
  login.status = 'error';
  login.error = ptyOutput || 'No credentials found after code exchange';

  log('error', 'Auth code exchange failed', {
    loginId: body.login_id,
    output: ptyOutput.slice(0, 500),
  });

  // Clean up temp dir
  rm(login.tempHome, { recursive: true, force: true }).catch(() => {});
  pendingLogins.delete(body.login_id);

  sendJSON(res, 502, {
    status: 'error',
    message: 'Code exchange failed. The auth code may be expired or invalid.',
    output: ptyOutput || null,
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
      expires_at: login.expiresAt ?? null,
      subscription_type: login.subscriptionType ?? null,
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

// ── POST /auth/refresh (token refresh via CLI) ───────────────────

export async function authRefreshHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = extractToken(req.headers.authorization);
  const userHash = hashToken(token);
  const paths = getUserPaths(token);
  const credPath = join(paths.claudeDir, '.credentials.json');

  // 1. Read current credentials
  if (!existsSync(credPath)) {
    throw new UnauthorizedError('No credentials found for this token. Use POST /auth/login first.');
  }

  let creds: Record<string, any>;
  try {
    creds = JSON.parse(await readFile(credPath, 'utf-8'));
  } catch {
    throw new UnauthorizedError('Corrupt credentials file. Use POST /auth/login to re-authenticate.');
  }

  const oauth = creds.claudeAiOauth;
  if (!oauth?.refreshToken) {
    throw new UnauthorizedError('No refresh token on file. Use POST /auth/login to authenticate fully.');
  }

  // 2. If token is still fresh (>1h remaining), return current values without spawning CLI
  const msRemaining = (oauth.expiresAt || 0) - Date.now();
  if (msRemaining > 60 * 60 * 1000) {
    sendJSON(res, 200, {
      status: 'fresh',
      access_token: oauth.accessToken,
      expires_at: oauth.expiresAt,
      subscription_type: oauth.subscriptionType ?? null,
      message: 'Token still valid, no refresh needed.',
    });
    return;
  }

  // 3. Spawn CLI to trigger auto-refresh (minimal prompt, bare mode)
  log('info', 'Triggering token refresh via CLI', { userHash });

  const result = await spawnRefresh(paths.home, paths.files);

  // 4. Re-read credentials after CLI ran
  let refreshedCreds: Record<string, any>;
  try {
    refreshedCreds = JSON.parse(await readFile(credPath, 'utf-8'));
  } catch {
    sendJSON(res, 500, {
      status: 'error',
      message: 'Failed to read credentials after refresh attempt.',
      stderr: result.stderr || null,
    });
    return;
  }

  const refreshedOauth = refreshedCreds.claudeAiOauth;
  if (!refreshedOauth?.accessToken) {
    sendJSON(res, 500, {
      status: 'error',
      message: 'Credentials file missing accessToken after refresh.',
      stderr: result.stderr || null,
    });
    return;
  }

  // Check if the token actually changed or expiresAt was extended
  const tokenChanged = refreshedOauth.accessToken !== oauth.accessToken;
  const expiryExtended = (refreshedOauth.expiresAt || 0) > (oauth.expiresAt || 0);

  if (!tokenChanged && !expiryExtended && result.exitCode !== 0) {
    // CLI failed and credentials didn't change → refresh failed
    sendJSON(res, 502, {
      status: 'refresh_failed',
      message: 'CLI could not refresh the token. Re-authentication may be required.',
      stderr: result.stderr || null,
    });
    return;
  }

  log('info', 'Token refresh completed', {
    userHash,
    tokenChanged,
    expiryExtended,
    newExpiresAt: refreshedOauth.expiresAt,
  });

  sendJSON(res, 200, {
    status: 'refreshed',
    access_token: refreshedOauth.accessToken,
    expires_at: refreshedOauth.expiresAt ?? null,
    subscription_type: refreshedOauth.subscriptionType ?? null,
    token_changed: tokenChanged,
  });
}

// ── Spawn helper for refresh ─────────────────────────────────────

function spawnRefresh(
  homePath: string,
  filesPath: string,
): Promise<{ exitCode: number | null; stderr: string }> {
  const absHome = resolve(homePath);
  const absFiles = resolve(filesPath);

  return new Promise((done) => {
    let stderr = '';

    const args: string[] = [
      ...config.claudePrependArgs,
      '-p', '.',
      '--output-format', 'stream-json',
      '--max-turns', '1',
      '--bare',
      '--permission-mode', 'bypassPermissions',
    ];

    let proc: ChildProcess;

    if (config.dockerIsolation) {

      proc = spawn('docker', [
        'run', '--rm', '-t',
        '--memory', config.dockerMemory,
        '--cpus', config.dockerCpus,
        '--network', 'bridge',
        '--read-only',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
        '-v', `${absHome}:/home/claude:rw`,
        '-v', `${absFiles}:/workspace:rw`,
        '-e', 'HOME=/home/claude',
        '-e', 'CI=1',
        '-w', '/workspace',
        config.dockerImage,
        ...args,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } else {
      proc = spawn(config.claudeBinary, args, {
        env: {
          ...process.env,
          HOME: homePath,
          USERPROFILE: homePath,
          APPDATA: join(homePath, 'AppData', 'Roaming'),
          DISPLAY: '',
          BROWSER: '',
          CI: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: filesPath,
        windowsHide: true,
      });
    }

    // Drain stdout (we don't need it, but must consume to avoid backpressure)
    proc.stdout?.resume();

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
      if (stderr.length > 8192) stderr = stderr.slice(-4096);
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
    }, 30_000); // 30s max for a refresh

    proc.on('close', (code) => {
      clearTimeout(timer);
      done({ exitCode: code, stderr: stderr.trim() });
    });
  });
}
