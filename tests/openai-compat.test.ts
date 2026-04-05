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
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers as any, body: Buffer.concat(chunks).toString('utf-8') }));
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
  tempDir = await mkdtemp(join(tmpdir(), 'claudeapi-oai-'));
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

const AUTH = { Authorization: 'Bearer sk-ant-oat01-openai-test' };

describe('POST /v1/chat/completions', () => {
  it('returns 401 without auth', async () => {
    const res = await httpReq('POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(res.status, 401);
  });

  it('returns 400 for missing messages', async () => {
    const res = await httpReq('POST', '/v1/chat/completions', { model: 'gpt-4' }, AUTH);
    assert.equal(res.status, 400);
  });

  it('non-streaming: returns OpenAI format response', async () => {
    const res = await httpReq('POST', '/v1/chat/completions', {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
    }, AUTH);

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.object, 'chat.completion');
    assert.ok(body.id.startsWith('chatcmpl-'));
    assert.ok(body.model);
    assert.ok(Array.isArray(body.choices));
    assert.equal(body.choices.length, 1);
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.ok(body.choices[0].message.content.includes('Echo:'));
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.ok(body.usage);
    assert.equal(typeof body.usage.prompt_tokens, 'number');
    assert.equal(typeof body.usage.completion_tokens, 'number');
    assert.equal(typeof body.usage.total_tokens, 'number');
  });

  it('streaming: returns OpenAI SSE format', async () => {
    const res = await httpReq('POST', '/v1/chat/completions', {
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'streaming test' }],
      stream: true,
    }, AUTH);

    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.toString().includes('text/event-stream'));

    // Parse SSE data lines
    const dataLines = res.body.split('\n')
      .filter(l => l.startsWith('data: '))
      .map(l => l.slice(6));

    // Should end with [DONE]
    assert.equal(dataLines[dataLines.length - 1], '[DONE]');

    // Parse non-DONE data lines
    const chunks = dataLines.slice(0, -1).map(l => JSON.parse(l));
    assert.ok(chunks.length > 0);
    assert.equal(chunks[0].object, 'chat.completion.chunk');
    assert.ok(chunks[0].id.startsWith('chatcmpl-'));

    // At least one chunk should have content
    const hasContent = chunks.some(c =>
      c.choices?.[0]?.delta?.content?.includes('Echo:')
    );
    assert.ok(hasContent, 'should have chunk with echo content');

    // Last chunk should have finish_reason: stop
    const lastChunk = chunks[chunks.length - 1];
    assert.equal(lastChunk.choices[0].finish_reason, 'stop');
  });

  it('handles system messages', async () => {
    const res = await httpReq('POST', '/v1/chat/completions', {
      messages: [
        { role: 'system', content: 'You are a pirate.' },
        { role: 'user', content: 'hello' },
      ],
    }, AUTH);

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.choices[0].message.content);
  });

  it('handles multi-turn conversation', async () => {
    const res = await httpReq('POST', '/v1/chat/completions', {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'how are you?' },
      ],
    }, AUTH);

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.choices[0].message.content);
  });

  it('maps gpt model names to claude models', async () => {
    // gpt-3.5-turbo → haiku (cheapest)
    const res = await httpReq('POST', '/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: 'test' }],
    }, AUTH);
    assert.equal(res.status, 200);
  });

  it('streaming: delta pattern (content_block_delta)', async () => {
    const res = await httpReq('POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: '__delta__' }],
      stream: true,
    }, AUTH);

    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Hello'));
    assert.ok(res.body.includes('[DONE]'));
  });
});
