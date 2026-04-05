import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { queue } from '../src/queue.js';
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
  tempDir = await mkdtemp(join(tmpdir(), 'claudeapi-queue-'));
  config.dataDir = tempDir;
  config.claudeBinary = process.execPath;
  config.claudePrependArgs = [MOCK_CLAUDE];
  config.logLevel = 'error';
  config.maxConcurrentGlobal = 2; // Low limit for testing
  config.maxConcurrentPerUser = 1;
  config.maxQueueSize = 5;
  config.queueTimeoutMs = 3000;
  app = createApp();
  await app.start(0, '127.0.0.1');
});

after(async () => {
  closeDb();
  Object.assign(config, origConfig);
  await app.close();
  await rm(tempDir, { recursive: true, force: true });
});

const AUTH = { Authorization: 'Bearer sk-ant-oat01-queue-test' };
const AUTH2 = { Authorization: 'Bearer sk-ant-oat01-queue-test-2' };

describe('Request Queue', () => {
  it('queue stats are available via /health', async () => {
    const res = await httpReq('GET', '/health');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok('queue' in body, 'should have queue stats');
    assert.equal(typeof body.queue.activeSlots, 'number');
    assert.equal(typeof body.queue.utilization, 'number');
  });

  it('processes requests normally when under capacity', async () => {
    const res = await httpReq('POST', '/v1/messages', {
      messages: [{ role: 'user', content: 'queue test' }],
      stream: false,
    }, AUTH);
    assert.equal(res.status, 200);
  });

  it('handles concurrent requests from different users', async () => {
    const results = await Promise.all([
      httpReq('POST', '/v1/messages', {
        messages: [{ role: 'user', content: 'user1' }],
        stream: false,
      }, AUTH),
      httpReq('POST', '/v1/messages', {
        messages: [{ role: 'user', content: 'user2' }],
        stream: false,
      }, AUTH2),
    ]);

    assert.equal(results[0].status, 200);
    assert.equal(results[1].status, 200);
  });

  it('queues requests that exceed per-user concurrency', async () => {
    // Per-user limit is 1. Send 2 requests from same user.
    // Second should be queued, then processed after first completes.
    const results = await Promise.all([
      httpReq('POST', '/v1/messages', {
        messages: [{ role: 'user', content: 'concurrent1' }],
        stream: false,
      }, AUTH),
      httpReq('POST', '/v1/messages', {
        messages: [{ role: 'user', content: 'concurrent2' }],
        stream: false,
      }, AUTH),
    ]);

    // Both should eventually succeed (second waits in queue)
    assert.equal(results[0].status, 200);
    assert.equal(results[1].status, 200);
  });

  it('queue stats reflect processed requests', async () => {
    const stats = queue.stats;
    assert.ok(stats.totalProcessed > 0, 'should have processed requests');
    assert.equal(stats.activeSlots, 0, 'no active slots after completion');
  });
});
