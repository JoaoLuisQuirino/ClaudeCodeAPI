import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { hashToken } from './hash.js';
import { UnauthorizedError } from './errors.js';
import { log } from './logger.js';

// ── Types ─────────────────────────────────────────────────────────

export interface UserPaths {
  /** HOME directory for the claude process */
  home: string;
  /** File upload directory */
  files: string;
  /** Session data directory */
  sessions: string;
  /** .claude credentials directory */
  claudeDir: string;
}

// ── Token extraction ──────────────────────────────────────────────

/**
 * Extract Bearer token from Authorization header.
 * Throws UnauthorizedError on missing/invalid auth.
 */
export function extractToken(authHeader: string | undefined, xApiKey?: string | undefined): string {
  // Support both: Authorization: Bearer <token> and x-api-key: <token>
  if (xApiKey) return xApiKey;

  if (!authHeader) throw new UnauthorizedError('Missing Authorization header or x-api-key');

  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!match?.[1]) throw new UnauthorizedError('Invalid Authorization format — expected "Bearer <token>"');

  return match[1];
}

// ── User paths ────────────────────────────────────────────────────

export function getUserPaths(token: string): UserPaths {
  const hash = hashToken(token);
  const userDir = join(config.dataDir, 'users', hash);
  const home = join(userDir, 'home');
  return {
    home,
    files: join(userDir, 'files'),
    sessions: join(userDir, 'sessions'),
    claudeDir: join(home, '.claude'),
  };
}

// ── Directory + credential setup ──────────────────────────────────

export async function ensureUserDirs(paths: UserPaths): Promise<void> {
  // mode 0o755: Docker containers run as uid 1000 (claude user) and need read/exec access
  await Promise.all([
    mkdir(paths.claudeDir, { recursive: true, mode: 0o755 }),
    mkdir(paths.files, { recursive: true, mode: 0o755 }),
    mkdir(paths.sessions, { recursive: true, mode: 0o755 }),
  ]);
}

/**
 * Setup user credentials for the claude binary.
 *
 * The token (accessToken) alone is NOT enough — the binary also requires
 * a refreshToken. On first use, the user must POST to /auth/setup with
 * their full credentials JSON. For subsequent requests, the accessToken
 * in the Bearer header is used to identify the user (lookup by hash).
 *
 * If credentials already exist on disk for this user, we skip writing.
 */
export async function setupCredentials(token: string): Promise<{ paths: UserPaths; userHash: string }> {
  const userHash = hashToken(token);
  const paths = getUserPaths(token);

  await ensureUserDirs(paths);

  // If no credentials file, create a minimal one.
  // Real auth requires POST /auth/login or POST /auth/setup first.
  // Without refreshToken, the claude binary will respond "Not logged in".
  const credPath = join(paths.claudeDir, '.credentials.json');
  if (!existsSync(credPath)) {
    const credData = JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        refreshToken: '',
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
        scopes: ['user:inference'],
      },
    }, null, 2);
    await writeFile(credPath, credData, { encoding: 'utf-8', mode: 0o644 });
    log('warn', 'Minimal credentials written — use POST /auth/login for full auth', { userHash });
  }

  return { paths, userHash };
}

/**
 * Write full credentials from the user's credential JSON.
 * Called by POST /auth/setup with the content of ~/.claude/.credentials.json.
 */
export async function writeFullCredentials(
  credentialsJson: Record<string, unknown>,
): Promise<{ userHash: string }> {
  // Extract accessToken to compute user hash
  const oauth = credentialsJson.claudeAiOauth as Record<string, unknown> | undefined;
  if (!oauth?.accessToken || typeof oauth.accessToken !== 'string') {
    throw new UnauthorizedError('credentials must contain claudeAiOauth.accessToken');
  }
  if (!oauth.refreshToken || typeof oauth.refreshToken !== 'string') {
    throw new UnauthorizedError('credentials must contain claudeAiOauth.refreshToken');
  }

  const token = oauth.accessToken;
  const userHash = hashToken(token);
  const paths = getUserPaths(token);

  await ensureUserDirs(paths);

  const credPath = join(paths.claudeDir, '.credentials.json');
  await writeFile(credPath, JSON.stringify(credentialsJson, null, 2), { encoding: 'utf-8', mode: 0o644 });

  log('info', 'Full credentials written', { userHash });
  return { userHash };
}

/**
 * Fast path: resolve paths + hash without writing credentials.
 */
export function resolveUser(token: string): { paths: UserPaths; userHash: string } {
  return { paths: getUserPaths(token), userHash: hashToken(token) };
}
