import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/router.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const noop = async () => {};

describe('Router', () => {
  it('matches exact path', () => {
    const r = new Router();
    r.get('/health', noop);
    const m = r.match('GET', '/health');
    assert.ok(m);
    assert.deepEqual(m.params, {});
  });

  it('returns null for no match', () => {
    const r = new Router();
    r.get('/health', noop);
    assert.equal(r.match('GET', '/other'), null);
  });

  it('matches method correctly', () => {
    const r = new Router();
    r.post('/data', noop);
    assert.equal(r.match('GET', '/data'), null);
    assert.ok(r.match('POST', '/data'));
  });

  it('extracts path params', () => {
    const r = new Router();
    r.delete('/sessions/:id', noop);
    const m = r.match('DELETE', '/sessions/abc123');
    assert.ok(m);
    assert.equal(m.params.id, 'abc123');
  });

  it('extracts multiple path params', () => {
    const r = new Router();
    r.get('/users/:userId/files/:fileId', noop);
    const m = r.match('GET', '/users/u1/files/f2');
    assert.ok(m);
    assert.equal(m.params.userId, 'u1');
    assert.equal(m.params.fileId, 'f2');
  });

  it('strips query string before matching', () => {
    const r = new Router();
    r.get('/health', noop);
    const m = r.match('GET', '/health?foo=bar');
    assert.ok(m);
  });

  it('decodes URI components in params', () => {
    const r = new Router();
    r.get('/files/:name', noop);
    const m = r.match('GET', '/files/hello%20world.txt');
    assert.ok(m);
    assert.equal(m.params.name, 'hello world.txt');
  });

  it('is case-sensitive for paths', () => {
    const r = new Router();
    r.get('/Health', noop);
    assert.equal(r.match('GET', '/health'), null);
    assert.ok(r.match('GET', '/Health'));
  });

  it('is case-insensitive for methods', () => {
    const r = new Router();
    r.post('/data', noop);
    assert.ok(r.match('post', '/data'));
    assert.ok(r.match('POST', '/data'));
  });

  it('matches nested paths', () => {
    const r = new Router();
    r.post('/v1/messages', noop);
    assert.ok(r.match('POST', '/v1/messages'));
    assert.equal(r.match('POST', '/v1'), null);
    assert.equal(r.match('POST', '/v1/messages/extra'), null);
  });
});
