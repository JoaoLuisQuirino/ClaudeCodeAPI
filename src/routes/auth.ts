import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, execSync, ChildProcess } from 'node:child_process';
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

/** Resolve full path of a binary (pty.spawn doesn't search PATH on Windows) */
let _resolvedClaude: string | undefined;
function resolveClaudeBinary(): string {
  if (_resolvedClaude) return _resolvedClaude;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    _resolvedClaude = execSync(`${cmd} ${config.claudeBinary}`, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
  } catch {
    _resolvedClaude = config.claudeBinary;
  }
  return _resolvedClaude;
}

// ── Pending login sessions ────────────────────────────────────────

interface PendingLogin {
  loginId: string;
  tempHome: string;
  credPath: string;
  ptyProc: ReturnType<typeof pty.spawn>;
  ptyOutput: string;
  ptyExited: boolean;
  credWatcher?: ReturnType<typeof setInterval>;
  createdAt: number;
  status: 'pending' | 'awaiting_authorization' | 'completed' | 'expired' | 'error';
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

  // Spawn claude auth login in a pseudo-terminal (CLI uses device flow polling)
  const ptyProc = pty.spawn(resolveClaudeBinary(), ['auth', 'login'], {
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
    login.status = 'awaiting_authorization';
    pendingLogins.set(loginId, login);
  } catch {
    ptyProc.kill();
    throw new BadRequestError('Failed to generate login URL. Is the claude binary available?');
  }

  // Background credential watcher — polls every 2s for .credentials.json
  const realHome = process.env.USERPROFILE || process.env.HOME || '';
  const possibleCredPaths = [
    credPath,
    join(realHome, '.claude', '.credentials.json'),
  ];

  login.credWatcher = setInterval(() => {
    if (login.status !== 'awaiting_authorization') {
      clearInterval(login.credWatcher!);
      return;
    }
    checkAndCompleteLogin(login, possibleCredPaths);
  }, 2000);

  // When PTY exits, do one final check then mark error if not completed
  ptyProc.onExit(() => {
    login.ptyExited = true;
    setTimeout(() => {
      if (login.status === 'awaiting_authorization') {
        checkAndCompleteLogin(login, possibleCredPaths);
        if (login.status === 'awaiting_authorization') {
          login.status = 'error';
          login.error = stripAnsi(login.ptyOutput).trim() || 'CLI exited without writing credentials';
          log('error', 'CLI exited without credentials', { loginId });
        }
      }
      if (login.credWatcher) clearInterval(login.credWatcher);
    }, 1000);
  });

  // Auto-cleanup after 5 minutes
  setTimeout(async () => {
    if (login.credWatcher) clearInterval(login.credWatcher);
    if (!login.ptyExited) ptyProc.kill();
    if (login.status === 'awaiting_authorization') login.status = 'expired';
    try { await rm(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
  }, 5 * 60 * 1000);

  sendJSON(res, 200, {
    login_id: loginId,
    auth_url: login.authUrl,
    message: 'Open auth_url in browser and authorize. Then call POST /auth/callback or poll GET /auth/status/:login_id.',
    expires_in_seconds: 300,
  });
}

/** Check credential files and mark login as completed if found */
function checkAndCompleteLogin(login: PendingLogin, credPaths: string[]): void {
  for (const p of credPaths) {
    if (!existsSync(p)) continue;
    try {
      const raw = require('node:fs').readFileSync(p, 'utf-8');
      const creds = JSON.parse(raw);
      const token = creds.claudeAiOauth?.accessToken;
      if (!token) continue;

      // Write to permanent user dir (async, fire-and-forget — status updates sync)
      writeFullCredentials(creds).catch(() => {});

      login.status = 'completed';
      login.accessToken = token;
      login.userHash = hashToken(token);
      login.expiresAt = creds.claudeAiOauth?.expiresAt;
      login.subscriptionType = creds.claudeAiOauth?.subscriptionType;

      log('info', 'OAuth login completed (device flow)', { loginId: login.loginId, userHash: login.userHash });

      // Cleanup temp dir
      rm(login.tempHome, { recursive: true, force: true }).catch(() => {});
      if (!login.ptyExited) login.ptyProc.kill();
      return;
    } catch { /* can't read, try next */ }
  }
}

// ── POST /auth/callback (long-poll — wait for device flow) ──��────

export async function authCallbackHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody<{ login_id: string; code?: string }>(req);

  if (!body.login_id) {
    throw new BadRequestError('login_id is required');
  }

  const login = pendingLogins.get(body.login_id);
  if (!login) {
    sendJSON(res, 404, { status: 'not_found', message: 'Login session not found or expired' });
    return;
  }

  // Already completed? Return immediately.
  if (login.status === 'completed') {
    sendJSON(res, 200, {
      status: 'completed',
      access_token: login.accessToken,
      user_hash: login.userHash,
      expires_at: login.expiresAt ?? null,
      subscription_type: login.subscriptionType ?? null,
    });
    pendingLogins.delete(body.login_id);
    return;
  }

  // Already failed?
  if (login.status === 'error') {
    sendJSON(res, 502, { status: 'error', message: login.error || 'Login failed' });
    pendingLogins.delete(body.login_id);
    return;
  }

  if (login.status === 'expired') {
    sendJSON(res, 410, { status: 'expired', message: 'Login session expired. Start a new one.' });
    pendingLogins.delete(body.login_id);
    return;
  }

  // Long-poll: wait for status to change (max 120s)
  log('info', 'Waiting for device flow completion...', { loginId: body.login_id });

  const finalStatus = await new Promise<string>((done) => {
    const timeout = setTimeout(() => done('timeout'), 120_000);
    const check = setInterval(() => {
      if (login.status !== 'awaiting_authorization' && login.status !== 'pending') {
        clearInterval(check);
        clearTimeout(timeout);
        done(login.status);
      }
    }, 1000);
  });

  if (finalStatus === 'completed') {
    sendJSON(res, 200, {
      status: 'completed',
      access_token: login.accessToken,
      user_hash: login.userHash,
      expires_at: login.expiresAt ?? null,
      subscription_type: login.subscriptionType ?? null,
    });
    pendingLogins.delete(body.login_id);
    return;
  }

  if (finalStatus === 'timeout') {
    sendJSON(res, 504, {
      status: 'timeout',
      message: 'Authorization not completed within 120s. User may not have authorized yet. Try again.',
    });
    return;
  }

  // error / expired
  const output = stripAnsi(login.ptyOutput).trim();
  sendJSON(res, 502, {
    status: login.status,
    message: login.error || 'Login failed',
    output: output || null,
  });
  pendingLogins.delete(body.login_id);
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
    message: login.status === 'awaiting_authorization'
      ? 'Waiting for user to authorize in browser. CLI is polling.'
      : 'Processing...',
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
