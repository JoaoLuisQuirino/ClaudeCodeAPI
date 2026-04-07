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

interface HttpRes { status: number; body: string; }

function httpReq(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpRes> {
  return new Promise((resolve, reject) => {
    const addr = app.server.address() as { port: number };
    const req = request({
      hostname: '127.0.0.1', port: addr.port, path, method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf-8') }));
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
  tempDir = await mkdtemp(join(tmpdir(), 'claudecodeapi-usage-'));
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

const AUTH = { Authorization: 'Bearer sk-ant-oat01-usage-test' };

describe('GET /usage', () => {
  it('returns 401 without auth', async () => {
    const res = await httpReq('GET', '/usage');
    assert.equal(res.status, 401);
  });

  it('returns empty usage for new user', async () => {
    const res = await httpReq('GET', '/usage', undefined, AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.totalRequests, 0);
    assert.equal(body.totalInputTokens, 0);
    assert.equal(body.totalOutputTokens, 0);
    assert.deepEqual(body.byModel, []);
    assert.deepEqual(body.recentRequests, []);
  });

  it('records usage from /v1/messages request', async () => {
    // Make a request that generates usage
    await httpReq('POST', '/v1/messages', {
      messages: [{ role: 'user', content: 'usage test' }],
      stream: false,
    }, AUTH);

    const res = await httpReq('GET', '/usage', undefined, AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.totalRequests >= 1, 'should have at least 1 request');
    assert.ok(body.recentRequests.length >= 1, 'should have recent requests');
    assert.equal(body.recentRequests[0].endpoint, '/v1/messages');
  });

  it('records usage from /v1/chat/completions request', async () => {
    await httpReq('POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'openai usage test' }],
    }, AUTH);

    const res = await httpReq('GET', '/usage', undefined, AUTH);
    const body = JSON.parse(res.body);
    const oaiReqs = body.recentRequests.filter((r: any) => r.endpoint === '/v1/chat/completions');
    assert.ok(oaiReqs.length >= 1, 'should have chat/completions usage');
  });

  it('records usage from /chat request', async () => {
    await httpReq('POST', '/chat', {
      message: 'chat usage test',
      stream: false,
    }, AUTH);

    const res = await httpReq('GET', '/usage', undefined, AUTH);
    const body = JSON.parse(res.body);
    const chatReqs = body.recentRequests.filter((r: any) => r.endpoint === '/chat');
    assert.ok(chatReqs.length >= 1, 'should have /chat usage');
  });

  it('aggregates by model', async () => {
    const res = await httpReq('GET', '/usage', undefined, AUTH);
    const body = JSON.parse(res.body);
    assert.ok(body.byModel.length > 0, 'should have by-model breakdown');
    for (const m of body.byModel) {
      assert.ok(m.model);
      assert.equal(typeof m.requests, 'number');
      assert.equal(typeof m.input_tokens, 'number');
      assert.equal(typeof m.output_tokens, 'number');
    }
  });

  it('respects limit parameter', async () => {
    const res = await httpReq('GET', '/usage?limit=1', undefined, AUTH);
    const body = JSON.parse(res.body);
    assert.ok(body.recentRequests.length <= 1);
  });
});
