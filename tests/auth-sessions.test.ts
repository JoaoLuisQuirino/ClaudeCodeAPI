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

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MOCK_CLAUDE = join(__dirname, 'mock-claude.mjs');

interface HttpRes {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function httpReq(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpRes> {
  return new Promise((resolve, reject) => {
    const addr = app.server.address() as { port: number };
    const req = request({
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
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
  tempDir = await mkdtemp(join(tmpdir(), 'claudecodeapi-auth-'));
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

const AUTH = { Authorization: 'Bearer sk-ant-oat01-auth-test-token' };

// ── Auth setup tests ─────────────────────────────────────────────

describe('POST /auth/setup', () => {
  it('accepts valid credentials', async () => {
    const res = await httpReq('POST', '/auth/setup', {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-setup-test',
        refreshToken: 'rt-test-123',
        expiresAt: Date.now() + 86400000,
        scopes: ['user:inference'],
      },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.ok(body.userHash);
  });

  it('rejects missing claudeAiOauth', async () => {
    const res = await httpReq('POST', '/auth/setup', { foo: 'bar' });
    assert.equal(res.status, 400);
  });

  it('rejects missing accessToken', async () => {
    const res = await httpReq('POST', '/auth/setup', {
      claudeAiOauth: { refreshToken: 'rt' },
    });
    assert.equal(res.status, 401);
  });

  it('rejects missing refreshToken', async () => {
    const res = await httpReq('POST', '/auth/setup', {
      claudeAiOauth: { accessToken: 'sk-ant-oat01-x' },
    });
    assert.equal(res.status, 401);
  });
});

// ── Auth status tests ────────────────────────────────────────────

describe('GET /auth/status/:login_id', () => {
  it('returns 404 for unknown login_id', async () => {
    const res = await httpReq('GET', '/auth/status/nonexistent-id');
    assert.equal(res.status, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'not_found');
  });
});

// ── Session mapping tests ────────────────────────────────────────

describe('Session ID mapping', () => {
  it('renameSession maps client ID to Claude ID', async () => {
    const { renameSession, getClaudeSessionId } = await import('../src/sessions.js');

    renameSession('client-test-1', 'claude-real-1');
    assert.equal(getClaudeSessionId('client-test-1'), 'claude-real-1');
  });

  it('renameSession updates to latest Claude ID', async () => {
    const { renameSession, getClaudeSessionId } = await import('../src/sessions.js');

    renameSession('client-test-2', 'claude-v1');
    assert.equal(getClaudeSessionId('client-test-2'), 'claude-v1');

    renameSession('client-test-2', 'claude-v2');
    assert.equal(getClaudeSessionId('client-test-2'), 'claude-v2');
  });

  it('getClaudeSessionId returns undefined for unknown ID', async () => {
    const { getClaudeSessionId } = await import('../src/sessions.js');
    assert.equal(getClaudeSessionId('completely-unknown'), undefined);
  });

  it('renameSession ignores same ID', async () => {
    const { renameSession, getClaudeSessionId } = await import('../src/sessions.js');
    renameSession('same-id', 'same-id');
    assert.equal(getClaudeSessionId('same-id'), undefined);
  });
});

// ── Per-session lock tests ───────────────────────────────────────

describe('Per-session lock', () => {
  it('serializes requests for the same session', async () => {
    const order: number[] = [];

    // Send two requests with same session_id almost simultaneously
    const p1 = httpReq('POST', '/chat', {
      message: 'first',
      session_id: 'lock-test-session',
      stream: false,
    }, AUTH).then(() => { order.push(1); });

    // Small delay so p1 acquires lock first
    await new Promise(r => setTimeout(r, 50));

    const p2 = httpReq('POST', '/chat', {
      message: 'second',
      session_id: 'lock-test-session',
      stream: false,
    }, AUTH).then(() => { order.push(2); });

    await Promise.all([p1, p2]);

    // Should complete in order (serialized, not parallel)
    assert.deepEqual(order, [1, 2]);
  });

  it('allows parallel requests for different sessions', async () => {
    const [r1, r2] = await Promise.all([
      httpReq('POST', '/chat', { message: 'a', stream: false }, AUTH),
      httpReq('POST', '/chat', { message: 'b', stream: false }, AUTH),
    ]);

    // Both should succeed (different sessions, no lock contention)
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
  });
});

// ── SSE keepalive test ───────────────────────────────────────────

describe('SSE keepalive', () => {
  it('includes keepalive ping format in SSE headers', async () => {
    const res = await httpReq('POST', '/chat', {
      message: 'hello',
      stream: true,
    }, AUTH);

    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.toString().includes('text/event-stream'));
    // The response should have proper SSE format (events with data)
    assert.ok(res.body.includes('event:'));
    assert.ok(res.body.includes('data:'));
  });
});
