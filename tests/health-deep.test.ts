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

function httpReq(method: string, path: string): Promise<HttpRes> {
  return new Promise((resolve, reject) => {
    const addr = app.server.address() as { port: number };
    const req = request({ hostname: '127.0.0.1', port: addr.port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

let app: AppServer;
let tempDir: string;
const origConfig = { ...config };

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'claudeapi-health-'));
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

describe('Health endpoints', () => {
  it('GET /health returns full health detail', async () => {
    const res = await httpReq('GET', '/health');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(['healthy', 'degraded', 'unhealthy'].includes(body.status));
    assert.equal(typeof body.uptime, 'number');
    // Process metrics
    assert.ok(body.process);
    assert.equal(typeof body.process.rss_mb, 'number');
    assert.equal(typeof body.process.heap_used_mb, 'number');
    assert.equal(typeof body.process.pid, 'number');
    // Queue
    assert.ok(body.queue);
    assert.equal(typeof body.queue.activeSlots, 'number');
    assert.equal(typeof body.queue.utilization, 'number');
    // Disk
    assert.ok(body.disk);
    // Checks
    assert.ok(body.checks);
    assert.equal(typeof body.checks.memory_ok, 'boolean');
    assert.equal(typeof body.checks.disk_ok, 'boolean');
    assert.equal(typeof body.checks.queue_ok, 'boolean');
  });

  it('GET /health/live returns alive status', async () => {
    const res = await httpReq('GET', '/health/live');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'alive');
  });

  it('GET /health/ready returns ready status', async () => {
    const res = await httpReq('GET', '/health/ready');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ready');
  });
});
