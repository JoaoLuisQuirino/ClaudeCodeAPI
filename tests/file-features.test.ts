import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';

// ── Test: getUserDiskUsage + checkQuota ────────────────────────────

describe('quota', () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'claudecodeapi-quota-'));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('getUserDiskUsage returns 0 for empty dir', async () => {
    const { getUserDiskUsage } = await import('../src/quota.js');
    const emptyDir = join(tempDir, 'empty');
    await mkdir(emptyDir, { recursive: true });
    const usage = await getUserDiskUsage(emptyDir);
    assert.equal(usage.totalBytes, 0);
    assert.equal(usage.fileCount, 0);
  });

  it('getUserDiskUsage counts file sizes', async () => {
    const { getUserDiskUsage } = await import('../src/quota.js');
    const dir = join(tempDir, 'with-files');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'hello');       // 5 bytes
    await writeFile(join(dir, 'b.txt'), 'world!!');     // 7 bytes
    const usage = await getUserDiskUsage(dir);
    assert.equal(usage.totalBytes, 12);
    assert.equal(usage.fileCount, 2);
  });

  it('getUserDiskUsage returns 0 for nonexistent dir', async () => {
    const { getUserDiskUsage } = await import('../src/quota.js');
    const usage = await getUserDiskUsage(join(tempDir, 'nonexistent'));
    assert.equal(usage.totalBytes, 0);
    assert.equal(usage.fileCount, 0);
  });

  it('checkQuota passes when under limit', async () => {
    const { checkQuota } = await import('../src/quota.js');
    const { config } = await import('../src/config.js');
    const dir = join(tempDir, 'quota-ok');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'small.txt'), 'data');

    const orig = config.maxUserDiskBytes;
    try {
      config.maxUserDiskBytes = 1024 * 1024; // 1MB
      await checkQuota(dir, 100); // Should not throw
    } finally {
      config.maxUserDiskBytes = orig;
    }
  });

  it('checkQuota throws when over limit', async () => {
    const { checkQuota } = await import('../src/quota.js');
    const { config } = await import('../src/config.js');
    const dir = join(tempDir, 'quota-over');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(500));

    const orig = config.maxUserDiskBytes;
    try {
      config.maxUserDiskBytes = 600; // Very small limit
      await assert.rejects(
        () => checkQuota(dir, 200),
        (err: Error) => {
          assert.ok(err.message.includes('quota exceeded'), `Expected quota message, got: ${err.message}`);
          return true;
        },
      );
    } finally {
      config.maxUserDiskBytes = orig;
    }
  });
});

// ── Test: downloadFileHandler ─────────────────────────────────────

describe('downloadFileHandler', () => {
  let tempDir: string;
  let origDataDir: string;

  before(async () => {
    const { config } = await import('../src/config.js');
    tempDir = await mkdtemp(join(tmpdir(), 'claudecodeapi-download-'));
    origDataDir = config.dataDir;
    config.dataDir = tempDir;
  });

  after(async () => {
    const { config } = await import('../src/config.js');
    config.dataDir = origDataDir;
    await rm(tempDir, { recursive: true, force: true });
  });

  // Helper: create a fake request/response pair
  function createMockReq(auth: string): IncomingMessage {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.headers = { authorization: auth };
    return req;
  }

  function createMockRes(): { res: any; getResult: () => { status: number; headers: Record<string, any>; body: Buffer } } {
    const chunks: Buffer[] = [];
    let status = 200;
    let headers: Record<string, any> = {};
    let headWritten = false;

    const res = {
      destroyed: false,
      writableEnded: false,
      writeHead(s: number, h: Record<string, any>) {
        status = s;
        headers = h;
        headWritten = true;
      },
      write(chunk: Buffer | string) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        chunks.push(buf);
        return true;
      },
      end(data?: Buffer | string) {
        if (data) {
          const buf = typeof data === 'string' ? Buffer.from(data) : data;
          chunks.push(buf);
        }
        res.writableEnded = true;
      },
      // pipe target interface
      on(_event: string, _cb: Function) { return res; },
      once(_event: string, _cb: Function) { return res; },
      emit(_event: string, ..._args: any[]) { return true; },
      removeListener(_event: string, _cb: Function) { return res; },
    };

    return {
      res,
      getResult: () => ({ status, headers, body: Buffer.concat(chunks) }),
    };
  }

  it('serves a text file with correct content-type', async () => {
    const { downloadFileHandler } = await import('../src/routes/files.js');
    const { setupCredentials } = await import('../src/credentials.js');

    const token = 'sk-ant-oat01-download-test-token';
    const { paths } = await setupCredentials(token);
    await writeFile(join(paths.files, 'readme.txt'), 'Hello Download');

    const req = createMockReq(`Bearer ${token}`);
    const { res, getResult } = createMockRes();

    await downloadFileHandler(req, res as any, { name: 'readme.txt' });

    const result = getResult();
    assert.equal(result.status, 200);
    assert.equal(result.headers['Content-Type'], 'text/plain');
    assert.ok(result.headers['Content-Disposition'].includes('readme.txt'));
  });

  it('serves a JSON file with correct content-type', async () => {
    const { downloadFileHandler } = await import('../src/routes/files.js');
    const { setupCredentials } = await import('../src/credentials.js');

    const token = 'sk-ant-oat01-download-test-token';
    const { paths } = await setupCredentials(token);
    await writeFile(join(paths.files, 'data.json'), '{"key":"val"}');

    const req = createMockReq(`Bearer ${token}`);
    const { res, getResult } = createMockRes();

    await downloadFileHandler(req, res as any, { name: 'data.json' });

    const result = getResult();
    assert.equal(result.status, 200);
    assert.equal(result.headers['Content-Type'], 'application/json');
  });

  it('serves a CSV file with correct content-type', async () => {
    const { downloadFileHandler } = await import('../src/routes/files.js');
    const { setupCredentials } = await import('../src/credentials.js');

    const token = 'sk-ant-oat01-download-test-token';
    const { paths } = await setupCredentials(token);
    await writeFile(join(paths.files, 'report.csv'), 'a,b,c\n1,2,3');

    const req = createMockReq(`Bearer ${token}`);
    const { res, getResult } = createMockRes();

    await downloadFileHandler(req, res as any, { name: 'report.csv' });

    const result = getResult();
    assert.equal(result.status, 200);
    assert.equal(result.headers['Content-Type'], 'text/csv');
  });

  it('returns 404 for nonexistent file', async () => {
    const { downloadFileHandler } = await import('../src/routes/files.js');

    const token = 'sk-ant-oat01-download-test-token';
    const req = createMockReq(`Bearer ${token}`);
    const { res } = createMockRes();

    await assert.rejects(
      () => downloadFileHandler(req, res as any, { name: 'nope.txt' }),
      (err: any) => {
        assert.equal(err.statusCode, 404);
        return true;
      },
    );
  });

  it('blocks path traversal with ..', async () => {
    const { downloadFileHandler } = await import('../src/routes/files.js');

    const token = 'sk-ant-oat01-download-test-token';
    const req = createMockReq(`Bearer ${token}`);
    const { res } = createMockRes();

    await assert.rejects(
      () => downloadFileHandler(req, res as any, { name: '../../etc/passwd' }),
      (err: any) => {
        assert.equal(err.statusCode, 404);
        return true;
      },
    );
  });

  it('blocks path traversal with backslash', async () => {
    const { downloadFileHandler } = await import('../src/routes/files.js');

    const token = 'sk-ant-oat01-download-test-token';
    const req = createMockReq(`Bearer ${token}`);
    const { res } = createMockRes();

    await assert.rejects(
      () => downloadFileHandler(req, res as any, { name: '..\\..\\etc\\passwd' }),
      (err: any) => {
        assert.equal(err.statusCode, 404);
        return true;
      },
    );
  });

  it('blocks path traversal with forward slash', async () => {
    const { downloadFileHandler } = await import('../src/routes/files.js');

    const token = 'sk-ant-oat01-download-test-token';
    const req = createMockReq(`Bearer ${token}`);
    const { res } = createMockRes();

    await assert.rejects(
      () => downloadFileHandler(req, res as any, { name: 'sub/file.txt' }),
      (err: any) => {
        assert.equal(err.statusCode, 404);
        return true;
      },
    );
  });

  it('defaults to octet-stream for unknown extensions', async () => {
    const { downloadFileHandler } = await import('../src/routes/files.js');
    const { setupCredentials } = await import('../src/credentials.js');

    const token = 'sk-ant-oat01-download-test-token';
    const { paths } = await setupCredentials(token);
    await writeFile(join(paths.files, 'binary.dat'), Buffer.from([0x00, 0x01, 0x02]));

    const req = createMockReq(`Bearer ${token}`);
    const { res, getResult } = createMockRes();

    await downloadFileHandler(req, res as any, { name: 'binary.dat' });

    const result = getResult();
    assert.equal(result.status, 200);
    assert.equal(result.headers['Content-Type'], 'application/octet-stream');
  });
});

// ── Test: file-cleanup ────────────────────────────────────────────

describe('file-cleanup', () => {
  let tempDir: string;
  let origDataDir: string;
  let origFileCleanupHours: number;

  before(async () => {
    const { config } = await import('../src/config.js');
    tempDir = await mkdtemp(join(tmpdir(), 'claudecodeapi-cleanup-'));
    origDataDir = config.dataDir;
    origFileCleanupHours = config.fileCleanupHours;
    config.dataDir = tempDir;
    config.logLevel = 'error';
  });

  after(async () => {
    const { config } = await import('../src/config.js');
    config.dataDir = origDataDir;
    config.fileCleanupHours = origFileCleanupHours;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('deletes files older than fileCleanupHours', async () => {
    const { _cleanOldFiles } = await import('../src/file-cleanup.js');
    const { config } = await import('../src/config.js');

    // Create user files structure
    const userFilesDir = join(tempDir, 'users', 'testhash', 'files');
    await mkdir(userFilesDir, { recursive: true });

    // Create a "recent" file
    await writeFile(join(userFilesDir, 'recent.txt'), 'recent');

    // Create an "old" file — set mtime to 48 hours ago
    const oldFilePath = join(userFilesDir, 'old.txt');
    await writeFile(oldFilePath, 'old');
    const { utimes } = await import('node:fs/promises');
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(oldFilePath, oldTime, oldTime);

    // Set cleanup to 24h
    config.fileCleanupHours = 24;

    await _cleanOldFiles();

    // Old file should be gone
    let oldExists = true;
    try {
      await stat(oldFilePath);
    } catch {
      oldExists = false;
    }
    assert.equal(oldExists, false, 'Old file should be deleted');

    // Recent file should remain
    const recentStat = await stat(join(userFilesDir, 'recent.txt'));
    assert.ok(recentStat.isFile(), 'Recent file should still exist');
  });

  it('handles nonexistent users directory gracefully', async () => {
    const { _cleanOldFiles } = await import('../src/file-cleanup.js');
    const { config } = await import('../src/config.js');

    const emptyDir = join(tempDir, 'empty-data');
    config.dataDir = emptyDir;

    // Should not throw
    await _cleanOldFiles();

    // Restore
    config.dataDir = tempDir;
  });

  it('startFileCleanup returns a timer and stopFileCleanup clears it', async () => {
    const { startFileCleanup, stopFileCleanup } = await import('../src/file-cleanup.js');
    const timer = startFileCleanup();
    assert.ok(timer, 'Should return a timer');
    stopFileCleanup(timer);
    // No error means success
  });
});

// ── Test: getClientIp ─────────────────────────────────────────────

describe('getClientIp', () => {
  let origTrustProxy: boolean;

  before(async () => {
    const { config } = await import('../src/config.js');
    origTrustProxy = config.trustProxy;
  });

  afterEach(async () => {
    const { config } = await import('../src/config.js');
    config.trustProxy = origTrustProxy;
  });

  function createReqWithHeaders(headers: Record<string, string>, remoteAddress?: string): IncomingMessage {
    const socket = new Socket();
    if (remoteAddress) {
      Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress, writable: true });
    }
    const req = new IncomingMessage(socket);
    req.headers = headers;
    return req;
  }

  it('returns remoteAddress when trustProxy is false', async () => {
    const { getClientIp } = await import('../src/proxy.js');
    const { config } = await import('../src/config.js');
    config.trustProxy = false;

    const req = createReqWithHeaders(
      { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' },
      '10.0.0.1',
    );
    const ip = getClientIp(req);
    assert.equal(ip, '10.0.0.1');
  });

  it('uses CF-Connecting-IP when trustProxy is true', async () => {
    const { getClientIp } = await import('../src/proxy.js');
    const { config } = await import('../src/config.js');
    config.trustProxy = true;

    const req = createReqWithHeaders(
      { 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' },
      '10.0.0.1',
    );
    assert.equal(getClientIp(req), '1.1.1.1');
  });

  it('uses X-Real-IP when CF-Connecting-IP is absent', async () => {
    const { getClientIp } = await import('../src/proxy.js');
    const { config } = await import('../src/config.js');
    config.trustProxy = true;

    const req = createReqWithHeaders(
      { 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3, 4.4.4.4' },
      '10.0.0.1',
    );
    assert.equal(getClientIp(req), '2.2.2.2');
  });

  it('uses first X-Forwarded-For entry when others are absent', async () => {
    const { getClientIp } = await import('../src/proxy.js');
    const { config } = await import('../src/config.js');
    config.trustProxy = true;

    const req = createReqWithHeaders(
      { 'x-forwarded-for': '3.3.3.3, 4.4.4.4, 5.5.5.5' },
      '10.0.0.1',
    );
    assert.equal(getClientIp(req), '3.3.3.3');
  });

  it('falls back to remoteAddress when no proxy headers', async () => {
    const { getClientIp } = await import('../src/proxy.js');
    const { config } = await import('../src/config.js');
    config.trustProxy = true;

    const req = createReqWithHeaders({}, '192.168.1.1');
    assert.equal(getClientIp(req), '192.168.1.1');
  });

  it('strips ::ffff: prefix', async () => {
    const { getClientIp } = await import('../src/proxy.js');
    const { config } = await import('../src/config.js');
    config.trustProxy = false;

    const req = createReqWithHeaders({}, '::ffff:192.168.1.1');
    assert.equal(getClientIp(req), '192.168.1.1');
  });

  it('returns 127.0.0.1 when no remoteAddress', async () => {
    const { getClientIp } = await import('../src/proxy.js');
    const { config } = await import('../src/config.js');
    config.trustProxy = false;

    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.headers = {};
    // socket.remoteAddress is undefined by default on unconnected sockets
    const ip = getClientIp(req);
    assert.equal(ip, '127.0.0.1');
  });
});

// ── Test: config fields ───────────────────────────────────────────

describe('config new fields', () => {
  it('has maxUserDiskBytes', async () => {
    const { config } = await import('../src/config.js');
    assert.equal(typeof config.maxUserDiskBytes, 'number');
    assert.equal(config.maxUserDiskBytes, 500 * 1024 * 1024);
  });

  it('has trustProxy', async () => {
    const { config } = await import('../src/config.js');
    assert.equal(typeof config.trustProxy, 'boolean');
  });
});
