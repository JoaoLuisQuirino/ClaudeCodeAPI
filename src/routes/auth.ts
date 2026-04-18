import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { parseJsonBody } from '../body-parser.js';
import { extractToken, getUserPaths, writeFullCredentials } from '../credentials.js';
import { BadRequestError, UnauthorizedError } from '../errors.js';
import { getRequestIp } from '../rate-limit.js';
import { log } from '../logger.js';
import { hashToken } from '../hash.js';

// ── OAuth constants (extracted from Claude Code binary) ──────────

const OAUTH = {
  CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  AUTHORIZE_URL: 'https://claude.com/cai/oauth/authorize',
  TOKEN_URL: 'https://platform.claude.com/v1/oauth/token',
  REDIRECT_URI: 'https://platform.claude.com/oauth/code/callback',
  SCOPES: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
};

const UPSTREAM_TIMEOUT_MS = 10_000;
const USER_AGENT = 'claude-cli/2.1.104 (external, cli)';

// ── Response helper (no-store for all auth endpoints) ────────────

function sendAuthJSON(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

// ── Internal key (shared secret for /auth/refresh-stateless) ─────

let _internalKey: string | null | undefined;
function getInternalKey(): string | null {
  if (_internalKey !== undefined) return _internalKey;

  if (process.env.INTERNAL_KEY) {
    _internalKey = process.env.INTERNAL_KEY.trim();
    return _internalKey || null;
  }

  try {
    _internalKey = readFileSync('/etc/claudeapi/internal.key', 'utf-8').trim();
    return _internalKey || null;
  } catch {
    _internalKey = null;
    return null;
  }
}

function checkInternalKey(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Rate limit for /auth/refresh-stateless (60/min per IP) ───────

const refreshStatelessWindows = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, w] of refreshStatelessWindows) {
    if (w.resetAt <= now) refreshStatelessWindows.delete(ip);
  }
}, 60_000).unref();

function checkRefreshRateLimit(ip: string): boolean {
  const now = Date.now();
  let w = refreshStatelessWindows.get(ip);
  if (!w || w.resetAt <= now) {
    w = { count: 0, resetAt: now + 60_000 };
    refreshStatelessWindows.set(ip, w);
  }
  w.count++;
  return w.count <= 60;
}

// ── PKCE helpers ─────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ── Upstream token call (shared by callback + refresh) ───────────

type TokenEndpointResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error_class: 'invalid_grant' | 'network' | 'timeout' | 'bad_response'; status?: number };

async function callTokenEndpoint(body: Record<string, string>): Promise<TokenEndpointResult> {
  let response: Response;
  try {
    response = await fetch(OAUTH.TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, error_class: isTimeout ? 'timeout' : 'network' };
  }

  let data: Record<string, unknown>;
  try {
    data = await response.json() as Record<string, unknown>;
  } catch {
    return { ok: false, error_class: 'bad_response', status: response.status };
  }

  if (!response.ok) {
    return { ok: false, error_class: 'invalid_grant', status: response.status };
  }

  if (!data.access_token || typeof data.access_token !== 'string') {
    return { ok: false, error_class: 'bad_response', status: response.status };
  }

  return { ok: true, data };
}

// ── Pending login sessions ────────────────────────────────────────

interface PendingLogin {
  loginId: string;
  codeVerifier: string;
  createdAt: number;
  status: 'awaiting_code' | 'completed' | 'expired' | 'error';
  authUrl: string;
  accessToken?: string;
  userHash?: string;
  expiresAt?: number;
  subscriptionType?: string;
  error?: string;
}

const pendingLogins = new Map<string, PendingLogin>();

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

  sendAuthJSON(res, 200, {
    status: 'ok',
    message: 'Credentials stored. Use your accessToken as Bearer token for API requests.',
    userHash,
  });
}

// ── POST /auth/login (start OAuth PKCE flow) ─────────────────────

export async function authLoginHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const loginId = randomUUID();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    code: 'true',
    client_id: OAUTH.CLIENT_ID,
    response_type: 'code',
    redirect_uri: OAUTH.REDIRECT_URI,
    scope: OAUTH.SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: loginId,
  });

  const authUrl = `${OAUTH.AUTHORIZE_URL}?${params}`;

  const login: PendingLogin = {
    loginId,
    codeVerifier,
    createdAt: Date.now(),
    status: 'awaiting_code',
    authUrl,
  };
  pendingLogins.set(loginId, login);

  setTimeout(() => {
    if (login.status === 'awaiting_code') login.status = 'expired';
  }, 10 * 60 * 1000);

  log('info', 'oauth_login', { outcome: 'started', loginId });

  sendAuthJSON(res, 200, {
    login_id: loginId,
    auth_url: authUrl,
    message: 'Open auth_url in browser, authorize, then POST the code to /auth/callback.',
    expires_in_seconds: 600,
  });
}

// ── POST /auth/callback (exchange code for tokens) ───────────────

export async function authCallbackHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody<{ login_id: string; code: string }>(req);

  if (!body.login_id || !body.code) {
    throw new BadRequestError('login_id and code are required');
  }

  const login = pendingLogins.get(body.login_id);
  if (!login) {
    sendAuthJSON(res, 404, { status: 'not_found', message: 'Login session not found or expired' });
    return;
  }

  if (login.status !== 'awaiting_code') {
    sendAuthJSON(res, 400, { status: login.status, message: `Login is ${login.status}, cannot accept code` });
    return;
  }

  const safeCode = body.code.replace(/[^a-zA-Z0-9_#\-]/g, '');
  if (safeCode !== body.code) {
    login.status = 'error';
    login.error = 'Invalid characters in auth code';
    sendAuthJSON(res, 400, { status: 'error', message: 'Invalid auth code format' });
    return;
  }

  const result = await callTokenEndpoint({
    grant_type: 'authorization_code',
    code: safeCode,
    client_id: OAUTH.CLIENT_ID,
    redirect_uri: OAUTH.REDIRECT_URI,
    code_verifier: login.codeVerifier,
    state: login.loginId,
  });

  if (!result.ok) {
    login.status = 'error';
    login.error = result.error_class;
    log('info', 'oauth_callback', { outcome: 'fail', loginId: body.login_id, error_class: result.error_class, status: result.status });
    const code = result.error_class === 'invalid_grant' ? 401 : 502;
    sendAuthJSON(res, code, { status: 'error', error: result.error_class });
    pendingLogins.delete(body.login_id);
    return;
  }

  const accessToken = result.data.access_token as string;
  const refreshToken = (result.data.refresh_token as string) || '';
  const expiresIn = result.data.expires_in as number | undefined;
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : Date.now() + 8 * 60 * 60 * 1000;

  // Write credentials to disk (keeps /auth/refresh legado working during transition)
  const credentials = {
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt,
      scopes: OAUTH.SCOPES.split(' '),
    },
  };

  const { userHash } = await writeFullCredentials(credentials);

  login.status = 'completed';
  login.accessToken = accessToken;
  login.userHash = userHash;
  login.expiresAt = expiresAt;

  log('info', 'oauth_callback', { outcome: 'ok', loginId: body.login_id, userHash });

  sendAuthJSON(res, 200, {
    status: 'completed',
    access_token: accessToken,
    refresh_token: refreshToken,
    user_hash: userHash,
    expires_at: expiresAt,
    subscription_type: login.subscriptionType ?? null,
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
    sendAuthJSON(res, 404, { status: 'not_found', message: 'Login session not found or expired' });
    return;
  }

  if (login.status === 'completed') {
    sendAuthJSON(res, 200, {
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
    sendAuthJSON(res, 410, { status: 'expired', message: 'Login session expired. Start a new one.' });
    pendingLogins.delete(loginId);
    return;
  }

  if (login.status === 'error') {
    sendAuthJSON(res, 500, { status: 'error', error: login.error || 'unknown' });
    pendingLogins.delete(loginId);
    return;
  }

  sendAuthJSON(res, 202, {
    status: login.status,
    message: 'Waiting for auth code. POST it to /auth/callback.',
  });
}

// ── POST /auth/refresh (legado — reads refresh_token from disk) ──

export async function authRefreshHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = extractToken(req.headers.authorization);
  const userHash = hashToken(token);
  const paths = getUserPaths(token);
  const credPath = join(paths.claudeDir, '.credentials.json');

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

  // Skip refresh if token is still fresh (>1h remaining)
  const msRemaining = (oauth.expiresAt || 0) - Date.now();
  if (msRemaining > 60 * 60 * 1000) {
    sendAuthJSON(res, 200, {
      status: 'fresh',
      access_token: oauth.accessToken,
      expires_at: oauth.expiresAt,
      subscription_type: oauth.subscriptionType ?? null,
      message: 'Token still valid, no refresh needed.',
    });
    return;
  }

  const result = await callTokenEndpoint({
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: OAUTH.CLIENT_ID,
  });

  if (!result.ok) {
    log('info', 'oauth_refresh', { outcome: 'fail', userHash, error_class: result.error_class, status: result.status });
    const code = result.error_class === 'invalid_grant' ? 401 : 502;
    sendAuthJSON(res, code, { status: 'refresh_failed', error: result.error_class });
    return;
  }

  const newAccessToken = result.data.access_token as string;
  const newRefreshToken = (result.data.refresh_token as string) || oauth.refreshToken;
  const expiresIn = result.data.expires_in as number | undefined;
  const newExpiresAt = expiresIn ? Date.now() + expiresIn * 1000 : Date.now() + 8 * 60 * 60 * 1000;

  creds.claudeAiOauth.accessToken = newAccessToken;
  creds.claudeAiOauth.refreshToken = newRefreshToken;
  creds.claudeAiOauth.expiresAt = newExpiresAt;

  await writeFile(credPath, JSON.stringify(creds, null, 2), { encoding: 'utf-8', mode: 0o644 });

  const tokenChanged = newAccessToken !== oauth.accessToken;

  log('info', 'oauth_refresh', { outcome: 'ok', userHash, tokenChanged });

  sendAuthJSON(res, 200, {
    status: 'refreshed',
    access_token: newAccessToken,
    expires_at: newExpiresAt,
    subscription_type: oauth.subscriptionType ?? null,
    token_changed: tokenChanged,
  });
}

// ── POST /auth/refresh-stateless (Worker holds the refresh_token) ─

export async function authRefreshStatelessHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 1. Internal key must be configured
  const internalKey = getInternalKey();
  if (!internalKey) {
    log('warn', 'refresh_stateless', { outcome: 'fail', error_class: 'not_configured' });
    sendAuthJSON(res, 503, { error: 'internal_key_not_configured' });
    return;
  }

  // 2. Rate limit per IP (60/min)
  const ip = getRequestIp(req);
  if (!checkRefreshRateLimit(ip)) {
    log('info', 'refresh_stateless', { outcome: 'fail', error_class: 'rate_limited' });
    sendAuthJSON(res, 429, { error: 'rate_limited' });
    return;
  }

  // 3. Verify X-Internal-Key (constant-time)
  const providedKey = req.headers['x-internal-key'];
  if (typeof providedKey !== 'string' || !checkInternalKey(providedKey, internalKey)) {
    log('info', 'refresh_stateless', { outcome: 'fail', error_class: 'unauthorized' });
    sendAuthJSON(res, 401, { error: 'unauthorized' });
    return;
  }

  // 4. Parse body
  let body: { refresh_token?: string };
  try {
    body = await parseJsonBody<{ refresh_token?: string }>(req);
  } catch {
    sendAuthJSON(res, 400, { error: 'invalid_body' });
    return;
  }

  if (!body.refresh_token || typeof body.refresh_token !== 'string') {
    sendAuthJSON(res, 400, { error: 'refresh_token_required' });
    return;
  }

  // 5. Call Anthropic
  const result = await callTokenEndpoint({
    grant_type: 'refresh_token',
    refresh_token: body.refresh_token,
    client_id: OAUTH.CLIENT_ID,
  });

  if (!result.ok) {
    log('info', 'refresh_stateless', { outcome: 'fail', error_class: result.error_class, status: result.status });
    const code = result.error_class === 'invalid_grant' ? 401 : 502;
    sendAuthJSON(res, code, { error: result.error_class });
    return;
  }

  const newAccessToken = result.data.access_token as string;
  const newRefreshToken = (result.data.refresh_token as string) || body.refresh_token;
  const expiresIn = result.data.expires_in as number | undefined;
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : Date.now() + 8 * 60 * 60 * 1000;

  log('info', 'refresh_stateless', { outcome: 'ok' });

  sendAuthJSON(res, 200, {
    access_token: newAccessToken,
    refresh_token: newRefreshToken,
    expires_at: expiresAt,
  });
}
