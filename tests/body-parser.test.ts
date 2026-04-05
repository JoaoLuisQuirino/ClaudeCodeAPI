import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { IncomingMessage } from 'node:http';
import { parseJsonBody } from '../src/body-parser.js';

/** Create a fake IncomingMessage from raw data */
function fakeReq(data: string | Buffer | null): IncomingMessage {
  const readable = new Readable({ read() {} }) as IncomingMessage;
  if (data !== null) {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    // Push in microtask to allow listener attachment
    queueMicrotask(() => {
      readable.push(buf);
      readable.push(null);
    });
  } else {
    queueMicrotask(() => readable.push(null));
  }
  return readable;
}

describe('parseJsonBody', () => {
  it('parses valid JSON object', async () => {
    const body = await parseJsonBody<{ name: string }>(fakeReq('{"name":"test"}'));
    assert.deepEqual(body, { name: 'test' });
  });

  it('parses valid JSON array', async () => {
    const body = await parseJsonBody<number[]>(fakeReq('[1,2,3]'));
    assert.deepEqual(body, [1, 2, 3]);
  });

  it('rejects empty body', async () => {
    await assert.rejects(parseJsonBody(fakeReq(null)), /Empty request body/);
  });

  it('rejects invalid JSON', async () => {
    await assert.rejects(parseJsonBody(fakeReq('not json')), /Invalid JSON/);
  });

  it('rejects oversized body', async () => {
    const huge = Buffer.alloc(11 * 1024 * 1024, 'x'); // 11MB
    await assert.rejects(parseJsonBody(fakeReq(huge)), /exceeds/);
  });

  it('handles unicode correctly', async () => {
    const body = await parseJsonBody<{ text: string }>(fakeReq('{"text":"日本語テスト"}'));
    assert.equal(body.text, '日本語テスト');
  });

  it('handles nested objects', async () => {
    const input = { a: { b: { c: [1, 2, { d: true }] } } };
    const body = await parseJsonBody(fakeReq(JSON.stringify(input)));
    assert.deepEqual(body, input);
  });
});
