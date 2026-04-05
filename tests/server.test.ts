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

// ── HTTP helpers ──────────────────────────────────────────────────

interface HttpRes {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function httpReq(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpRes> {
  return new Promise((resolve, reject) => {
    const addr = app.server.address() as { port: number };
    const opts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
    };
    const req = request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Setup / Teardown ──────────────────────────────────────────────

let app: AppServer;
let tempDir: string;
const origConfig = { ...config };

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'claudeapi-srv-'));
  config.dataDir = tempDir;
  config.claudeBinary = process.execPath; // node
  config.claudePrependArgs = [MOCK_CLAUDE];
  config.logLevel = 'error'; // quiet during tests

  app = createApp();
  await app.start(0, '127.0.0.1');
});

after(async () => {
  closeDb();
  Object.assign(config, origConfig);
  await app.close();
  await rm(tempDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await httpReq('GET', '/health');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(['healthy', 'degraded', 'unhealthy'].includes(body.status));
    assert.equal(typeof body.uptime, 'number');
  });
});

describe('404', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await httpReq('GET', '/nonexistent');
    assert.equal(res.status, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.error.type, 'not_found_error');
  });
});

describe('CORS', () => {
  it('handles OPTIONS preflight', async () => {
    const res = await httpReq('OPTIONS', '/v1/messages');
    assert.equal(res.status, 204);
    assert.ok(res.headers['access-control-allow-origin']);
  });
});

describe('POST /v1/messages', () => {
  const AUTH = { Authorization: 'Bearer sk-ant-oat01-test123' };

  it('returns 401 without auth', async () => {
    const res = await httpReq('POST', '/v1/messages', {
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(res.status, 401);
  });

  it('returns 400 with empty body', async () => {
    // Send no body — content-length 0
    const res = await httpReq('POST', '/v1/messages', undefined, AUTH);
    assert.equal(res.status, 400);
  });

  it('returns 400 for missing messages', async () => {
    const res = await httpReq('POST', '/v1/messages', { model: 'opus' }, AUTH);
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.message.includes('messages'));
  });

  it('returns 400 for empty messages array', async () => {
    const res = await httpReq('POST', '/v1/messages', { messages: [] }, AUTH);
    assert.equal(res.status, 400);
  });

  it('non-streaming: returns complete JSON response', async () => {
    const res = await httpReq('POST', '/v1/messages', {
      model: 'opus',
      messages: [{ role: 'user', content: 'say hello' }],
      stream: false,
    }, AUTH);

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.ok(Array.isArray(body.content));
    assert.equal(body.content[0].type, 'text');
    assert.ok(body.content[0].text.includes('Echo:'));
    assert.equal(body.stop_reason, 'end_turn');
    assert.ok(body.usage);
  });

  it('streaming: returns SSE events', async () => {
    const res = await httpReq('POST', '/v1/messages', {
      model: 'opus',
      messages: [{ role: 'user', content: 'say hello' }],
      stream: true,
    }, AUTH);

    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.toString().includes('text/event-stream'));

    // Parse SSE events
    const lines = res.body.split('\n');
    const events: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event: ')) events.push(line.slice(7));
    }

    assert.ok(events.includes('message_start'), 'should have message_start');
    assert.ok(events.includes('content_block_start'), 'should have content_block_start');
    assert.ok(events.includes('content_block_delta'), 'should have content_block_delta');
    assert.ok(events.includes('content_block_stop'), 'should have content_block_stop');
    assert.ok(events.includes('message_delta'), 'should have message_delta');
    assert.ok(events.includes('message_stop'), 'should have message_stop');

    // Verify delta contains text
    const dataLines = res.body.split('\n').filter(l => l.startsWith('data: '));
    const hasDelta = dataLines.some(l => {
      try {
        const d = JSON.parse(l.slice(6));
        return d.type === 'content_block_delta' && d.delta?.text?.includes('Echo:');
      } catch { return false; }
    });
    assert.ok(hasDelta, 'should have delta with echo text');
  });

  it('streaming: handles tool events (hidden in provider mode)', async () => {
    const res = await httpReq('POST', '/v1/messages', {
      model: 'opus',
      messages: [{ role: 'user', content: '__tools__' }],
      stream: true,
    }, AUTH);

    assert.equal(res.status, 200);
    // Tool events should NOT appear in SSE output
    assert.ok(!res.body.includes('"tool_use"'), 'tool_use should be hidden');
    assert.ok(!res.body.includes('"tool_result"'), 'tool_result should be hidden');

    // But text should still be there
    const dataLines = res.body.split('\n').filter(l => l.startsWith('data: '));
    const hasText = dataLines.some(l => {
      try {
        const d = JSON.parse(l.slice(6));
        return d.type === 'content_block_delta' && d.delta?.text;
      } catch { return false; }
    });
    assert.ok(hasText, 'should still have text content');
  });

  it('streaming: content_block_delta pattern (pattern B)', async () => {
    const res = await httpReq('POST', '/v1/messages', {
      model: 'opus',
      messages: [{ role: 'user', content: '__delta__' }],
      stream: true,
    }, AUTH);

    assert.equal(res.status, 200);

    // Should contain all delta text fragments
    assert.ok(res.body.includes('Hello'));
    assert.ok(res.body.includes(' from'));
    assert.ok(res.body.includes(' deltas!'));
  });

  it('non-streaming: multi-turn conversation', async () => {
    const res = await httpReq('POST', '/v1/messages', {
      model: 'opus',
      messages: [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'first reply' },
        { role: 'user', content: 'second message' },
      ],
      stream: false,
    }, AUTH);

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.content[0].type, 'text');
    // Should contain the multi-turn prompt
    assert.ok(body.content[0].text.includes('Echo:'));
  });
});
