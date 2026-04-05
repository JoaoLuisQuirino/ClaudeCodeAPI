import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
export function extractToken(authHeader: string | undefined): string {
  if (!authHeader) throw new UnauthorizedError('Missing Authorization header');

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
  await Promise.all([
    mkdir(paths.claudeDir, { recursive: true }),
    mkdir(paths.files, { recursive: true }),
    mkdir(paths.sessions, { recursive: true }),
  ]);
}

/**
 * Write the OAuth token so the claude binary can authenticate.
 * Creates user directories if they don't exist.
 *
 * The exact credential format may need adjustment based on the
 * Claude Code binary version. Currently writes the format used by
 * Claude Code's credential store.
 */
export async function setupCredentials(token: string): Promise<{ paths: UserPaths; userHash: string }> {
  const userHash = hashToken(token);
  const paths = getUserPaths(token);

  await ensureUserDirs(paths);

  // Write credentials in the format Claude Code expects
  const credPath = join(paths.claudeDir, '.credentials.json');
  const credData = JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
    },
  }, null, 2);

  await writeFile(credPath, credData, 'utf-8');

  log('debug', 'Credentials written', { userHash });

  return { paths, userHash };
}

/**
 * Fast path: resolve paths + hash without writing credentials.
 * Use when credentials were already set up for this token.
 */
export function resolveUser(token: string): { paths: UserPaths; userHash: string } {
  return { paths: getUserPaths(token), userHash: hashToken(token) };
}
