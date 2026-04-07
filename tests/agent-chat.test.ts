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

// ── HTTP helper ──────────────────────────────────────────────────

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

// ── Setup ─────────────────────────────────────────────────────────

let app: AppServer;
let tempDir: string;
const origConfig = { ...config };

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'claudecodeapi-agent-'));
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

const AUTH = { Authorization: 'Bearer sk-ant-oat01-agent-test' };

// ── Agent tests ───────────────────────────────────────────────────

describe('POST /agent', () => {
  it('returns 401 without auth', async () => {
    const res = await httpReq('POST', '/agent', { task: 'hello' });
    assert.equal(res.status, 401);
  });

  it('returns 400 for missing task', async () => {
    const res = await httpReq('POST', '/agent', { model: 'opus' }, AUTH);
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.message.includes('task'));
  });

  it('non-streaming: returns complete agent result', async () => {
    const res = await httpReq('POST', '/agent', {
      task: 'say hello',
      stream: false,
    }, AUTH);

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.session_id, 'should have session_id');
    assert.ok(body.result.includes('Echo:'), 'should have result text');
    assert.ok(body.usage, 'should have usage');
    assert.ok(Array.isArray(body.events), 'should have events array');
  });

  it('streaming: returns SSE with all event types including tools', async () => {
    const res = await httpReq('POST', '/agent', {
      task: '__tools__',
      stream: true,
    }, AUTH);

    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.toString().includes('text/event-stream'));

    // Agent mode should include tool events (unlike Provider mode)
    assert.ok(res.body.includes('event: tool_use'), 'should have tool_use events');
    assert.ok(res.body.includes('event: tool_result'), 'should have tool_result events');
    assert.ok(res.body.includes('event: assistant'), 'should have assistant events');
    assert.ok(res.body.includes('event: result'), 'should have result event');
  });

  it('streaming: returns session metadata', async () => {
    const res = await httpReq('POST', '/agent', {
      task: 'test session',
      stream: true,
    }, AUTH);

    assert.equal(res.status, 200);
    // Should have session event with session_id
    assert.ok(res.body.includes('event: session'), 'should have session event');
  });
});

// ── Chat tests ────────────────────────────────────────────────────

describe('POST /chat', () => {
  it('returns 401 without auth', async () => {
    const res = await httpReq('POST', '/chat', { message: 'hello' });
    assert.equal(res.status, 401);
  });

  it('returns 400 for missing message', async () => {
    const res = await httpReq('POST', '/chat', {}, AUTH);
    assert.equal(res.status, 400);
  });

  it('non-streaming: returns message with session_id', async () => {
    const res = await httpReq('POST', '/chat', {
      message: 'hello world',
      stream: false,
    }, AUTH);

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.session_id, 'should have session_id');
    assert.ok(body.message.includes('Echo:'), 'should have response text');
    assert.ok(body.usage, 'should have usage');
  });

  it('streaming: returns SSE events', async () => {
    const res = await httpReq('POST', '/chat', {
      message: 'streaming test',
      stream: true,
    }, AUTH);

    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.toString().includes('text/event-stream'));
    assert.ok(res.body.includes('event: assistant'));
  });

  it('supports session_id for multi-turn', async () => {
    // First message
    const res1 = await httpReq('POST', '/chat', {
      message: 'first message',
      stream: false,
    }, AUTH);
    const body1 = JSON.parse(res1.body);
    assert.ok(body1.session_id);

    // Continue with same session_id
    const res2 = await httpReq('POST', '/chat', {
      message: 'second message',
      session_id: body1.session_id,
      stream: false,
    }, AUTH);
    assert.equal(res2.status, 200);
    const body2 = JSON.parse(res2.body);
    assert.ok(body2.message);
  });

  it('CLAUDE.md and mcp-config persist across messages (stable cwd)', async () => {
    const { existsSync } = await import('node:fs');
    const { readFile } = await import('node:fs/promises');
    const { hashToken } = await import('../src/hash.js');

    const token = 'sk-ant-oat01-agent-test';
    const userHash = hashToken(token);
    const filesDir = join(tempDir, 'users', userHash, 'files');
    const homeDir = join(tempDir, 'users', userHash, 'home');

    // First message with context_md and mcp_config
    const res1 = await httpReq('POST', '/chat', {
      message: 'hello',
      stream: false,
      context_md: '# Test Context\nYou are a test agent.',
      mcp_config: { mcpServers: { test: { type: 'http', url: 'http://localhost:9999' } } },
    }, AUTH);
    assert.equal(res1.status, 200);
    const body1 = JSON.parse(res1.body);
    assert.ok(body1.session_id);

    // CLAUDE.md in files dir (stable cwd)
    assert.ok(existsSync(join(filesDir, 'CLAUDE.md')), 'CLAUDE.md should be in files dir');
    const claudeMd = await readFile(join(filesDir, 'CLAUDE.md'), 'utf-8');
    assert.ok(claudeMd.includes('Test Context'));

    // MCP config in home dir
    assert.ok(existsSync(join(homeDir, 'mcp-config.json')), 'mcp-config should be in home dir');

    // Second message — same session, cwd stays the same
    const res2 = await httpReq('POST', '/chat', {
      message: 'second',
      session_id: body1.session_id,
      stream: false,
      mcp_config: { mcpServers: { test: { type: 'http', url: 'http://localhost:9999' } } },
    }, AUTH);
    assert.equal(res2.status, 200);

    // Files still there
    assert.ok(existsSync(join(filesDir, 'CLAUDE.md')), 'CLAUDE.md should persist');
    assert.ok(existsSync(join(homeDir, 'mcp-config.json')), 'mcp-config should persist');
  });
});

// ── Session tests ─────────────────────────────────────────────────

describe('GET /sessions', () => {
  it('returns 401 without auth', async () => {
    const res = await httpReq('GET', '/sessions');
    assert.equal(res.status, 401);
  });

  it('lists sessions for user', async () => {
    // Create a session first
    await httpReq('POST', '/chat', { message: 'session test', stream: false }, AUTH);

    const res = await httpReq('GET', '/sessions', undefined, AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.sessions));
    assert.ok(body.sessions.length > 0, 'should have at least one session');
    assert.ok(body.sessions[0].session_id);
    assert.ok(body.sessions[0].status);
  });
});

describe('DELETE /sessions/:id', () => {
  it('deletes an existing session', async () => {
    // Create a session
    const chatRes = await httpReq('POST', '/chat', { message: 'to delete', stream: false }, AUTH);
    const sessionId = JSON.parse(chatRes.body).session_id;

    // List to verify it exists
    const listRes = await httpReq('GET', '/sessions', undefined, AUTH);
    const before = JSON.parse(listRes.body).sessions;
    assert.ok(before.some((s: any) => s.session_id === sessionId));

    // Delete
    const delRes = await httpReq('DELETE', `/sessions/${sessionId}`, undefined, AUTH);
    assert.equal(delRes.status, 200);
    assert.ok(JSON.parse(delRes.body).deleted);
  });

  it('returns 404 for nonexistent session', async () => {
    const res = await httpReq('DELETE', '/sessions/nonexistent', undefined, AUTH);
    assert.equal(res.status, 404);
  });
});
