import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { extractToken, getUserPaths, setupCredentials } from '../src/credentials.js';
import { config } from '../src/config.js';
import { hashToken } from '../src/hash.js';

describe('extractToken', () => {
  it('extracts valid Bearer token', () => {
    assert.equal(extractToken('Bearer sk-ant-oat01-abc123'), 'sk-ant-oat01-abc123');
  });

  it('is case-insensitive for Bearer prefix', () => {
    assert.equal(extractToken('bearer mytoken'), 'mytoken');
    assert.equal(extractToken('BEARER mytoken'), 'mytoken');
  });

  it('throws on missing header', () => {
    assert.throws(() => extractToken(undefined), /Missing Authorization/);
  });

  it('throws on empty header', () => {
    assert.throws(() => extractToken(''), /Missing Authorization/);
  });

  it('throws on non-Bearer auth', () => {
    assert.throws(() => extractToken('Basic abc123'), /Invalid Authorization format/);
  });

  it('throws on Bearer without token', () => {
    assert.throws(() => extractToken('Bearer '), /Invalid Authorization format/);
  });

  it('throws on Bearer with only spaces', () => {
    assert.throws(() => extractToken('Bearer    '), /Invalid Authorization format/);
  });
});

describe('getUserPaths', () => {
  it('returns consistent paths for same token', () => {
    const a = getUserPaths('token1');
    const b = getUserPaths('token1');
    assert.deepEqual(a, b);
  });

  it('returns different paths for different tokens', () => {
    const a = getUserPaths('token1');
    const b = getUserPaths('token2');
    assert.notEqual(a.home, b.home);
  });

  it('paths contain user hash', () => {
    const hash = hashToken('mytoken');
    const paths = getUserPaths('mytoken');
    assert.ok(paths.home.includes(hash));
    assert.ok(paths.files.includes(hash));
    assert.ok(paths.claudeDir.includes(hash));
  });
});

describe('setupCredentials', () => {
  let origDataDir: string;
  let tempDir: string;

  before(async () => {
    origDataDir = config.dataDir;
    tempDir = await mkdtemp(join(tmpdir(), 'claudecodeapi-test-'));
    config.dataDir = tempDir;
  });

  after(async () => {
    config.dataDir = origDataDir;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates user directories and credentials file', async () => {
    const token = 'sk-ant-oat01-testtoken123';
    const { paths, userHash } = await setupCredentials(token);

    assert.ok(existsSync(paths.claudeDir), 'claudeDir should exist');
    assert.ok(existsSync(paths.files), 'files dir should exist');
    assert.ok(existsSync(paths.sessions), 'sessions dir should exist');

    const credPath = join(paths.claudeDir, '.credentials.json');
    assert.ok(existsSync(credPath), 'credentials file should exist');

    const raw = await readFile(credPath, 'utf-8');
    const creds = JSON.parse(raw);
    assert.equal(creds.claudeAiOauth.accessToken, token);

    assert.equal(userHash, hashToken(token));
  });

  it('overwrites credentials on re-setup', async () => {
    const token = 'sk-ant-oat01-overwrite-test';
    await setupCredentials(token);
    // Call again — should not throw
    const { paths } = await setupCredentials(token);
    const credPath = join(paths.claudeDir, '.credentials.json');
    const raw = await readFile(credPath, 'utf-8');
    const creds = JSON.parse(raw);
    assert.equal(creds.claudeAiOauth.accessToken, token);
  });
});
