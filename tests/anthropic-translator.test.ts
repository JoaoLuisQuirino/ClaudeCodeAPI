import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { AnthropicTranslator } from '../src/anthropic-translator.js';
import type { ClaudeEvent } from '../src/stream-parser.js';

/** Create a mock ServerResponse that captures written data. */
function mockRes(): { res: ServerResponse; data: string[] } {
  const data: string[] = [];
  let ended = false;
  const res = {
    destroyed: false,
    get writableEnded() { return ended; },
    writeHead() { return res; },
    write(chunk: string | Buffer) {
      data.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    },
    end() { ended = true; },
  } as unknown as ServerResponse;
  return { res, data };
}

function parseSSE(raw: string[]): Array<{ event: string; data: unknown }> {
  const text = raw.join('');
  const blocks = text.split('\n\n').filter(b => b.trim());
  return blocks.map(block => {
    const lines = block.split('\n');
    let event = '';
    let dataStr = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) dataStr = line.slice(6);
    }
    try {
      return { event, data: JSON.parse(dataStr) };
    } catch {
      return { event, data: dataStr };
    }
  });
}

describe('AnthropicTranslator', () => {
  it('translates assistant event (pattern A) to SSE', () => {
    const { res, data } = mockRes();
    const t = new AnthropicTranslator(res, 'claude-opus-4-6');

    t.handleEvent({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'text', text: 'Hello world' }],
        model: 'claude-opus-4-6',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    t.handleEvent({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    t.end();

    const events = parseSSE(data);
    const types = events.map(e => e.event);

    assert.ok(types.includes('message_start'));
    assert.ok(types.includes('content_block_start'));
    assert.ok(types.includes('content_block_delta'));
    assert.ok(types.includes('content_block_stop'));
    assert.ok(types.includes('message_delta'));
    assert.ok(types.includes('message_stop'));

    // Check delta contains text
    const delta = events.find(e => e.event === 'content_block_delta');
    assert.ok(delta);
    assert.equal((delta.data as any).delta.text, 'Hello world');
  });

  it('translates content_block_delta events (pattern B) to SSE', () => {
    const { res, data } = mockRes();
    const t = new AnthropicTranslator(res, 'sonnet');

    t.handleEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    t.handleEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } });
    t.handleEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } });
    t.handleEvent({ type: 'content_block_stop', index: 0 });
    t.handleEvent({ type: 'result', usage: { input_tokens: 5, output_tokens: 3 } });
    t.end();

    const events = parseSSE(data);

    // Should have pass-through content_block events + message envelope
    assert.ok(events.some(e => e.event === 'message_start'));
    assert.ok(events.some(e => e.event === 'message_stop'));
    assert.equal(t.accumulatedText, 'Hello world');
  });

  it('skips tool_use and tool_result events', () => {
    const { res, data } = mockRes();
    const t = new AnthropicTranslator(res, 'opus');

    t.handleEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Before tools' }] } });
    t.handleEvent({ type: 'tool_use', name: 'Read', input: {} });
    t.handleEvent({ type: 'tool_result', content: 'result' });
    t.handleEvent({ type: 'result', usage: { input_tokens: 5, output_tokens: 3 } });
    t.end();

    const raw = data.join('');
    assert.ok(!raw.includes('tool_use'));
    assert.ok(!raw.includes('tool_result'));
    assert.equal(t.accumulatedText, 'Before tools');
  });

  it('handles accumulated text correctly (pattern A progressive)', () => {
    const { res, data } = mockRes();
    const t = new AnthropicTranslator(res, 'opus');

    // Simulate progressive accumulation
    t.handleEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'He' }] } });
    t.handleEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } });
    t.handleEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } });
    t.handleEvent({ type: 'result', usage: { input_tokens: 5, output_tokens: 3 } });
    t.end();

    assert.equal(t.accumulatedText, 'Hello world');

    // Should have 3 deltas: "He", "llo", " world"
    const events = parseSSE(data);
    const deltas = events.filter(e => e.event === 'content_block_delta');
    assert.equal(deltas.length, 3);
    assert.equal((deltas[0].data as any).delta.text, 'He');
    assert.equal((deltas[1].data as any).delta.text, 'llo');
    assert.equal((deltas[2].data as any).delta.text, ' world');
  });

  it('handles empty response gracefully', () => {
    const { res, data } = mockRes();
    const t = new AnthropicTranslator(res, 'opus');
    t.end();

    const events = parseSSE(data);
    assert.ok(events.some(e => e.event === 'message_start'));
    assert.ok(events.some(e => e.event === 'message_stop'));
    assert.equal(t.accumulatedText, '');
  });

  it('records usage from result event', () => {
    const { res } = mockRes();
    const t = new AnthropicTranslator(res, 'opus');

    t.handleEvent({ type: 'result', usage: { input_tokens: 100, output_tokens: 50 } });
    t.end();

    assert.deepEqual(t.usage, { input_tokens: 100, output_tokens: 50 });
  });
});
