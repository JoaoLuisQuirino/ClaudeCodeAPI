import { config } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_NUM: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Sensitive keys that must never appear in logs
const REDACT_KEYS = new Set([
  'token', 'authorization', 'oauthToken', 'accessToken',
  'refreshToken', 'apiKey', 'secret', 'password', 'credential',
]);

function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEYS.has(k)) {
      clean[k] = '[REDACTED]';
    } else if (typeof v === 'string' && v.startsWith('sk-ant-')) {
      clean[k] = '[REDACTED]';
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

export function log(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_NUM[level] < LEVEL_NUM[config.logLevel]) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };

  if (data) Object.assign(entry, redact(data));

  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + '\n');
}
