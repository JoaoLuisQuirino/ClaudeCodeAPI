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

interface HttpRes { status: number; headers: Record<string, string | string[] | undefined>; body: string; }

function httpReq(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpRes> {
  return new Promise((resolve, reject) => {
    const addr = app.server.address() as { port: number };
    const req = request({
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: { ...(body && typeof body === 'object' && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers as any, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    if (body) req.write(Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function multipartUpload(fileName: string, content: string | Buffer, headers?: Record<string, string>): Promise<HttpRes> {
  return new Promise((resolve, reject) => {
    const addr = app.server.address() as { port: number };
    const boundary = '----TestBoundary' + Date.now();
    const fileData = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

    const parts: Buffer[] = [];
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`));
    parts.push(Buffer.from(`Content-Type: application/octet-stream\r\n`));
    parts.push(Buffer.from(`\r\n`));
    parts.push(fileData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const bodyBuf = Buffer.concat(parts);

    const req = request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: '/upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(bodyBuf.length),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers as any, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ── Setup ─────────────────────────────────────────────────────────

let app: AppServer;
let tempDir: string;
const origConfig = { ...config };

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'claudecodeapi-files-'));
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

const AUTH = { Authorization: 'Bearer sk-ant-oat01-file-test' };

// ── Upload tests ──────────────────────────────────────────────────

describe('POST /upload', () => {
  it('returns 401 without auth', async () => {
    const res = await multipartUpload('test.txt', 'hello');
    assert.equal(res.status, 401);
  });

  it('returns 400 for non-multipart content type', async () => {
    const res = await httpReq('POST', '/upload', { data: 'test' }, AUTH);
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.message.includes('multipart'));
  });

  it('uploads a text file', async () => {
    const res = await multipartUpload('hello.txt', 'Hello, world!', AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.uploaded));
    assert.equal(body.uploaded.length, 1);
    assert.equal(body.uploaded[0].name, 'hello.txt');
    assert.equal(body.uploaded[0].size, 13);
  });

  it('uploads a binary file', async () => {
    const binaryData = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG header
    const res = await multipartUpload('image.png', binaryData, AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.uploaded[0].name, 'image.png');
    assert.equal(body.uploaded[0].size, 8);
  });

  it('sanitizes dangerous filenames', async () => {
    const res = await multipartUpload('../../../etc/passwd', 'hacked', AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    // Should strip path traversal
    assert.ok(!body.uploaded[0].name.includes('..'));
  });
});

// ── List files tests ──────────────────────────────────────────────

describe('GET /files', () => {
  it('returns 401 without auth', async () => {
    const res = await httpReq('GET', '/files');
    assert.equal(res.status, 401);
  });

  it('lists uploaded files', async () => {
    // Upload first
    await multipartUpload('list-test.csv', 'a,b,c\n1,2,3', AUTH);

    const res = await httpReq('GET', '/files', undefined, AUTH);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.files));
    const found = body.files.find((f: any) => f.name === 'list-test.csv');
    assert.ok(found, 'should find uploaded file');
    assert.equal(typeof found.size, 'number');
    assert.ok(found.modified);
  });
});

// ── Delete file tests ─────────────────────────────────────────────

describe('DELETE /files/:name', () => {
  it('deletes an uploaded file', async () => {
    await multipartUpload('to-delete.txt', 'bye', AUTH);

    const delRes = await httpReq('DELETE', '/files/to-delete.txt', undefined, AUTH);
    assert.equal(delRes.status, 200);
    assert.ok(JSON.parse(delRes.body).deleted);

    // Verify it's gone
    const listRes = await httpReq('GET', '/files', undefined, AUTH);
    const files = JSON.parse(listRes.body).files;
    assert.ok(!files.some((f: any) => f.name === 'to-delete.txt'));
  });

  it('returns 404 for nonexistent file', async () => {
    const res = await httpReq('DELETE', '/files/nonexistent.txt', undefined, AUTH);
    assert.equal(res.status, 404);
  });

  it('rejects directory traversal', async () => {
    const res = await httpReq('DELETE', '/files/..%2F..%2Fetc%2Fpasswd', undefined, AUTH);
    assert.equal(res.status, 404);
  });
});
