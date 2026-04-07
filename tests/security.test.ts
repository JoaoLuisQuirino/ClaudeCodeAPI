import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { createApp, type AppServer } from '../src/server.js';
import { closeDb } from '../src/db.js';
import { hashToken } from '../src/hash.js';
import { validateModel, validateSessionId } from '../src/validate.js';
import { checkIpRateLimit } from '../src/rate-limit.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MOCK_CLAUDE = join(__dirname, 'mock-claude.mjs');

interface HttpRes { status: number; headers: Record<string, string | string[] | undefined>; body: string; }

function httpReq(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpRes> {
  return new Promise((resolve, reject) => {
    const addr = app.server.address() as { port: number };
    const req = request({
      hostname: '127.0.0.1', port: addr.port, path, method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers as Record<string, string | string[] | undefined>,
        body: Buffer.concat(chunks).toString('utf-8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let app: AppServer;
let tempDir: string;
const origConfig = { ...config };

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'claudecodeapi-sec-'));
  config.dataDir = tempDir;
  config.claudeBinary = process.execPath;
  config.claudePrependArgs = [MOCK_CLAUDE];
  config.logLevel = 'error';
  app = createApp();
  await app.start(0, '127.0.0.1');
});

after(async () => {
  closeDb();
  Object.assign(config, origConfig);
  await app.close();
  await rm(tempDir, { recursive: true, force: true });
});

const AUTH = { Authorization: 'Bearer sk-ant-oat01-security-test' };

describe('Security: Hash', () => {
  it('hash is 32 chars (128-bit entropy)', () => {
    const h = hashToken('test-token');
    assert.equal(h.length, 32);
    assert.ok(/^[0-9a-f]{32}$/.test(h));
  });

  it('different tokens produce different hashes', () => {
    const a = hashToken('token-a');
    const b = hashToken('token-b');
    assert.notEqual(a, b);
  });
});

describe('Security: Model validation', () => {
  it('accepts valid models', () => {
    assert.equal(validateModel('sonnet'), 'sonnet');
    assert.equal(validateModel('opus'), 'opus');
    assert.equal(validateModel('haiku'), 'haiku');
    assert.equal(validateModel('claude-opus-4-6'), 'claude-opus-4-6');
  });

  it('rejects invalid models', () => {
    assert.throws(() => validateModel('gpt-4; rm -rf /'), /not allowed/);
    assert.throws(() => validateModel('../../etc/passwd'), /not allowed/);
  });

  it('accepts versioned models', () => {
    assert.equal(validateModel('claude-sonnet-4-6-20251001'), 'claude-sonnet-4-6-20251001');
  });

  it('uses default model when undefined', () => {
    assert.equal(validateModel(undefined), config.defaultModel);
  });
});

describe('Security: Session ID validation', () => {
  it('accepts valid session IDs', () => {
    assert.equal(validateSessionId('sess_abc123'), 'sess_abc123');
    assert.equal(validateSessionId('my-session-01'), 'my-session-01');
  });

  it('rejects invalid session IDs', () => {
    assert.throws(() => validateSessionId('sess; rm -rf /'), /Invalid session_id/);
    assert.throws(() => validateSessionId('../../../etc'), /Invalid session_id/);
    assert.throws(() => validateSessionId('a'.repeat(200)), /Invalid session_id/);
  });

  it('returns undefined for undefined input', () => {
    assert.equal(validateSessionId(undefined), undefined);
  });
});

describe('Security: IP rate limiting', () => {
  it('allows normal request rate', () => {
    const result = checkIpRateLimit('10.0.0.1');
    assert.ok(result.allowed);
  });

  it('blocks excessive requests', () => {
    const testIp = '10.0.0.99';
    for (let i = 0; i < 121; i++) {
      checkIpRateLimit(testIp);
    }
    const result = checkIpRateLimit(testIp);
    assert.equal(result.allowed, false);
    assert.ok(result.retryAfterMs! > 0);
  });
});

describe('Security: Response headers', () => {
  it('includes security headers', async () => {
    const res = await httpReq('GET', '/health');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.ok(res.headers['strict-transport-security']?.toString().includes('max-age'));
  });

  it('includes CORS headers', async () => {
    const res = await httpReq('GET', '/health');
    assert.ok(res.headers['access-control-allow-origin']);
  });
});

describe('Security: Error sanitization', () => {
  it('does not expose internal errors to client', async () => {
    // Send invalid model to trigger an error through the validate path
    const res = await httpReq('POST', '/v1/messages', {
      model: 'invalid-model-name-injection',
      messages: [{ role: 'user', content: 'test' }],
    }, AUTH);
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    // Should have error message but NOT stack traces
    assert.ok(body.error.message);
    assert.ok(!body.error.stack);
  });
});

describe('Security: Config bounds', () => {
  it('maxConcurrentGlobal is bounded', () => {
    assert.ok(config.maxConcurrentGlobal >= 1);
    assert.ok(config.maxConcurrentGlobal <= 200);
  });

  it('processTimeoutMs is bounded', () => {
    assert.ok(config.processTimeoutMs >= 10_000);
    assert.ok(config.processTimeoutMs <= 30 * 60_000);
  });
});
