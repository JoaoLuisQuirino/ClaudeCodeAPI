import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { parseJsonBody } from '../body-parser.js';
import { extractToken, getUserPaths, writeFullCredentials } from '../credentials.js';
import { sendJSON } from '../sse.js';
import { BadRequestError, UnauthorizedError } from '../errors.js';
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

// ── PKCE helpers ─────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
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

  // Auto-expire after 10 minutes
  setTimeout(() => {
    if (login.status === 'awaiting_code') login.status = 'expired';
  }, 10 * 60 * 1000);

  log('info', 'OAuth login started', { loginId });

  sendJSON(res, 200, {
    login_id: loginId,
    auth_url: authUrl,
    message: 'Open auth_url in browser, authorize, then POST the code to /auth/callback.',
    expires_in_seconds: 600,
  });
}

// ── POST /auth/callback (exchange code for tokens — synchronous) ─

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

  // Sanitize code
  const safeCode = body.code.replace(/[^a-zA-Z0-9_#\-]/g, '');
  if (safeCode !== body.code) {
    login.status = 'error';
    login.error = 'Invalid characters in auth code';
    sendJSON(res, 400, { status: 'error', message: 'Invalid auth code format' });
    return;
  }

  log('info', 'Exchanging auth code for tokens...', { loginId: body.login_id });

  // Exchange code + code_verifier for tokens via Anthropic's token endpoint
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(OAUTH.TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'claude-cli/2.1.104 (external, cli)',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: safeCode,
        client_id: OAUTH.CLIENT_ID,
        redirect_uri: OAUTH.REDIRECT_URI,
        code_verifier: login.codeVerifier,
        state: login.loginId,
      }),
    });
  } catch (err) {
    login.status = 'error';
    login.error = `Network error calling token endpoint: ${err instanceof Error ? err.message : String(err)}`;
    sendJSON(res, 502, { status: 'error', message: login.error });
    pendingLogins.delete(body.login_id);
    return;
  }

  const tokenData = await tokenResponse.json() as Record<string, unknown>;

  if (!tokenResponse.ok) {
    login.status = 'error';
    login.error = `Token exchange failed: ${JSON.stringify(tokenData)}`;
    log('error', 'Token exchange failed', { loginId: body.login_id, status: tokenResponse.status, body: tokenData });
    sendJSON(res, 502, {
      status: 'error',
      message: 'Token exchange failed',
      detail: tokenData,
    });
    pendingLogins.delete(body.login_id);
    return;
  }

  // Extract tokens from response
  const accessToken = tokenData.access_token as string;
  const refreshToken = tokenData.refresh_token as string;
  const expiresIn = tokenData.expires_in as number | undefined;

  if (!accessToken) {
    login.status = 'error';
    login.error = 'Token response missing access_token';
    sendJSON(res, 502, { status: 'error', message: login.error, detail: tokenData });
    pendingLogins.delete(body.login_id);
    return;
  }

  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : Date.now() + 365 * 24 * 60 * 60 * 1000;

  // Write credentials in the format the claude binary expects
  const credentials = {
    claudeAiOauth: {
      accessToken,
      refreshToken: refreshToken || '',
      expiresAt,
      scopes: OAUTH.SCOPES.split(' '),
    },
  };

  const { userHash } = await writeFullCredentials(credentials);

  login.status = 'completed';
  login.accessToken = accessToken;
  login.userHash = userHash;
  login.expiresAt = expiresAt;

  log('info', 'OAuth login completed (PKCE)', { loginId: body.login_id, userHash });

  sendJSON(res, 200, {
    status: 'completed',
    access_token: accessToken,
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
    message: 'Waiting for auth code. POST it to /auth/callback.',
  });
}

// ── POST /auth/refresh (token refresh via HTTP) ──────────────────

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

  // 2. If token is still fresh (>1h remaining), return current values
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

  // 3. Refresh via HTTP (same token endpoint, different grant_type)
  log('info', 'Refreshing token via HTTP', { userHash });

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(OAUTH.TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: OAUTH.CLIENT_ID,
      }),
    });
  } catch (err) {
    sendJSON(res, 502, {
      status: 'error',
      message: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const tokenData = await tokenResponse.json() as Record<string, unknown>;

  if (!tokenResponse.ok) {
    sendJSON(res, 502, {
      status: 'refresh_failed',
      message: 'Token refresh failed. Re-authentication may be required.',
      detail: tokenData,
    });
    return;
  }

  const newAccessToken = tokenData.access_token as string;
  const newRefreshToken = tokenData.refresh_token as string;
  const expiresIn = tokenData.expires_in as number | undefined;

  if (!newAccessToken) {
    sendJSON(res, 502, { status: 'error', message: 'Refresh response missing access_token' });
    return;
  }

  const newExpiresAt = expiresIn ? Date.now() + expiresIn * 1000 : Date.now() + 365 * 24 * 60 * 60 * 1000;

  // Update credentials on disk
  creds.claudeAiOauth.accessToken = newAccessToken;
  if (newRefreshToken) creds.claudeAiOauth.refreshToken = newRefreshToken;
  creds.claudeAiOauth.expiresAt = newExpiresAt;

  await writeFile(credPath, JSON.stringify(creds, null, 2), { encoding: 'utf-8', mode: 0o644 });

  const tokenChanged = newAccessToken !== oauth.accessToken;

  log('info', 'Token refresh completed', { userHash, tokenChanged, newExpiresAt });

  sendJSON(res, 200, {
    status: 'refreshed',
    access_token: newAccessToken,
    expires_at: newExpiresAt,
    subscription_type: oauth.subscriptionType ?? null,
    token_changed: tokenChanged,
  });
}
