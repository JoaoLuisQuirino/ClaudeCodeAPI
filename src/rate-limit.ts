import { IncomingMessage } from 'node:http';
import { config } from './config.js';

/**
 * Sliding-window IP rate limiter. Zero dependencies.
 * Tracks request counts per IP in a fixed time window.
 */

interface WindowEntry {
  count: number;
  resetAt: number;
}

const windows = new Map<string, WindowEntry>();

// Cleanup stale entries every 60s
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of windows) {
    if (entry.resetAt <= now) windows.delete(ip);
  }
}, 60_000);
cleanupTimer.unref();

const WINDOW_MS = 60_000; // 1 minute window
const MAX_PER_WINDOW = 120; // 120 requests per minute per IP

/**
 * Check if an IP is rate-limited.
 * Returns { allowed: true } or { allowed: false, retryAfterMs }.
 */
export function checkIpRateLimit(ip: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  let entry = windows.get(ip);

  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    windows.set(ip, entry);
  }

  entry.count++;

  if (entry.count > MAX_PER_WINDOW) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }

  return { allowed: true };
}

/**
 * Extract client IP from request, respecting proxy headers if configured.
 */
export function getRequestIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp) return normalizeIp(cfIp);

    const realIp = req.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp) return normalizeIp(realIp);

    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) {
      const first = forwarded.split(',')[0].trim();
      if (first) return normalizeIp(first);
    }
  }

  return normalizeIp(req.socket?.remoteAddress || '127.0.0.1');
}

function normalizeIp(ip: string): string {
  // Strip IPv6-mapped IPv4 prefix
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}
