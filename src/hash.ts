import { createHash } from 'node:crypto';

/**
 * Deterministic, non-reversible hash of an OAuth token.
 * Returns first 32 hex chars of SHA-256 (128-bit) — used as user directory name.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}
