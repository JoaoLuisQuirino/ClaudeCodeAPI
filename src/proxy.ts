import type { IncomingMessage } from 'node:http';
import { config } from './config.js';

/**
 * Extract the real client IP from the request, respecting proxy headers
 * when config.trustProxy is true.
 *
 * Priority: CF-Connecting-IP > X-Real-IP > X-Forwarded-For (first) > remoteAddress
 * Strips the ::ffff: IPv4-mapped IPv6 prefix.
 */
export function getClientIp(req: IncomingMessage): string {
  let ip: string | undefined;

  if (config.trustProxy) {
    // Cloudflare
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) {
      ip = Array.isArray(cfIp) ? cfIp[0] : cfIp;
    }

    // X-Real-IP (nginx/reverse proxy)
    if (!ip) {
      const realIp = req.headers['x-real-ip'];
      if (realIp) {
        ip = Array.isArray(realIp) ? realIp[0] : realIp;
      }
    }

    // X-Forwarded-For (first entry is the client)
    if (!ip) {
      const xff = req.headers['x-forwarded-for'];
      if (xff) {
        const raw = Array.isArray(xff) ? xff[0] : xff;
        ip = raw.split(',')[0].trim();
      }
    }
  }

  // Fallback: direct connection
  if (!ip) {
    ip = req.socket.remoteAddress || '127.0.0.1';
  }

  // Strip ::ffff: prefix (IPv4-mapped IPv6)
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  return ip;
}
