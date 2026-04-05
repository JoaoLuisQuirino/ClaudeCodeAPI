import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { ClaudeStreamParser, type ClaudeEvent } from '../src/stream-parser.js';

function collect(parser: ClaudeStreamParser): Promise<ClaudeEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ClaudeEvent[] = [];
    parser.on('data', (e: ClaudeEvent) => events.push(e));
    parser.on('end', () => resolve(events));
    parser.on('error', reject);
  });
}

function feedLines(parser: ClaudeStreamParser, lines: string[]): void {
  const src = Readable.from([lines.join('\n') + '\n']);
  src.pipe(parser);
}

describe('ClaudeStreamParser', () => {
  it('parses single valid JSON line', async () => {
    const p = new ClaudeStreamParser();
    const prom = collect(p);
    feedLines(p, ['{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}']);
    const events = await prom;
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'assistant');
    assert.equal(events[0].message?.content?.[0]?.text, 'hi');
  });

  it('parses multiple lines', async () => {
    const p = new ClaudeStreamParser();
    const prom = collect(p);
    feedLines(p, [
      '{"type":"system","subtype":"init","session_id":"s1"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
      '{"type":"result","subtype":"success","duration_ms":100,"usage":{"input_tokens":10,"output_tokens":5},"session_id":"s1"}',
    ]);
    const events = await prom;
    assert.equal(events.length, 3);
    assert.equal(events[0].type, 'system');
    assert.equal(events[1].type, 'assistant');
    assert.equal(events[2].type, 'result');
    assert.equal(events[2].usage?.input_tokens, 10);
  });

  it('skips non-JSON lines', async () => {
    const p = new ClaudeStreamParser();
    const prom = collect(p);
    feedLines(p, [
      'DEBUG: starting up...',
      '{"type":"assistant","message":{"content":[]}}',
      'some warning text',
      '{"type":"result","subtype":"success"}',
    ]);
    const events = await prom;
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'assistant');
    assert.equal(events[1].type, 'result');
  });

  it('skips empty lines', async () => {
    const p = new ClaudeStreamParser();
    const prom = collect(p);
    feedLines(p, ['', '{"type":"result","subtype":"ok"}', '', '']);
    const events = await prom;
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'result');
  });

  it('skips JSON without type field', async () => {
    const p = new ClaudeStreamParser();
    const prom = collect(p);
    feedLines(p, [
      '{"foo":"bar"}',
      '{"type":"assistant","message":{}}',
    ]);
    const events = await prom;
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'assistant');
  });

  it('handles chunked data across buffer boundaries', async () => {
    const p = new ClaudeStreamParser();
    const prom = collect(p);

    // Simulate data arriving in small chunks that split a JSON line
    const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"split"}]}}';
    const mid = Math.floor(line.length / 2);

    const src = new Readable({ read() {} });
    src.pipe(p);
    src.push(Buffer.from(line.slice(0, mid)));
    src.push(Buffer.from(line.slice(mid) + '\n'));
    src.push(null);

    const events = await prom;
    assert.equal(events.length, 1);
    assert.equal(events[0].message?.content?.[0]?.text, 'split');
  });

  it('handles flush with remaining buffered data', async () => {
    const p = new ClaudeStreamParser();
    const prom = collect(p);

    // Send data without trailing newline
    const src = new Readable({ read() {} });
    src.pipe(p);
    src.push(Buffer.from('{"type":"result","subtype":"success"}'));
    src.push(null); // triggers flush

    const events = await prom;
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'result');
  });

  it('handles tool_use and tool_result events', async () => {
    const p = new ClaudeStreamParser();
    const prom = collect(p);
    feedLines(p, [
      '{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/test.txt"}}',
      '{"type":"tool_result","content":"file contents here"}',
    ]);
    const events = await prom;
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'tool_use');
    assert.equal(events[0].name, 'Read');
    assert.equal(events[1].type, 'tool_result');
    assert.equal(events[1].content, 'file contents here');
  });

  it('handles content_block_delta events', async () => {
    const p = new ClaudeStreamParser();
    const prom = collect(p);
    feedLines(p, [
      '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
      '{"type":"content_block_stop","index":0}',
    ]);
    const events = await prom;
    assert.equal(events.length, 4);
    assert.equal(events[0].type, 'content_block_start');
    assert.equal(events[1].delta?.text, 'Hello');
    assert.equal(events[2].delta?.text, ' world');
    assert.equal(events[3].type, 'content_block_stop');
  });

  it('handles large volume of events', async () => {
    const p = new ClaudeStreamParser();
    const prom = collect(p);
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"token${i}"}}`);
    }
    feedLines(p, lines);
    const events = await prom;
    assert.equal(events.length, 1000);
    assert.equal(events[999].delta?.text, 'token999');
  });
});
