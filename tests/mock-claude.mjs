#!/usr/bin/env node
/**
 * Mock claude binary for testing.
 * Reads -p prompt from args, outputs stream-json events to stdout.
 *
 * Special prompts:
 *   "__error__"    → exits with code 1
 *   "__timeout__"  → hangs forever (for timeout testing)
 *   "__tools__"    → outputs tool_use + tool_result events
 *   "__empty__"    → outputs result only (no text)
 *   "__delta__"    → outputs content_block_delta events (pattern B)
 *   anything else  → outputs assistant event with echo
 */

const args = process.argv.slice(2);
const pIdx = args.indexOf('-p');
const prompt = pIdx >= 0 && args[pIdx + 1] ? args[pIdx + 1] : '';

// Extract model from args
const mIdx = args.indexOf('--model');
const model = mIdx >= 0 && args[mIdx + 1] ? args[mIdx + 1] : 'sonnet';

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

if (prompt === '__error__') {
  process.stderr.write('Error: something went wrong\n');
  process.exit(1);
} else if (prompt === '__timeout__') {
  // Do nothing — hang until killed
  setInterval(() => {}, 60000);
} else if (prompt === '__empty__') {
  write({ type: 'result', subtype: 'success', duration_ms: 50, total_cost_usd: 0.0, usage: { input_tokens: 5, output_tokens: 0 }, session_id: 'sess_empty' });
} else if (prompt === '__tools__') {
  write({ type: 'assistant', message: { id: 'msg_t1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Let me read that file.' }], model, stop_reason: null, usage: { input_tokens: 10, output_tokens: 8 } } });
  write({ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/test.txt' } });
  write({ type: 'tool_result', content: 'file contents' });
  write({ type: 'assistant', message: { id: 'msg_t2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Let me read that file. The file contains: file contents' }], model, stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 15 } } });
  write({ type: 'result', subtype: 'success', duration_ms: 200, total_cost_usd: 0.005, usage: { input_tokens: 20, output_tokens: 15 }, session_id: 'sess_tools' });
} else if (prompt === '__delta__') {
  write({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  write({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } });
  write({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' from' } });
  write({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' deltas!' } });
  write({ type: 'content_block_stop', index: 0 });
  write({ type: 'result', subtype: 'success', duration_ms: 150, total_cost_usd: 0.002, usage: { input_tokens: 8, output_tokens: 4 }, session_id: 'sess_delta' });
} else {
  // Default: echo the prompt
  const responseText = `Echo: ${prompt}`;
  write({
    type: 'assistant',
    message: {
      id: 'msg_mock_001',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: responseText }],
      model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: responseText.split(' ').length },
    },
  });
  write({
    type: 'result',
    subtype: 'success',
    duration_ms: 100,
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: responseText.split(' ').length },
    session_id: 'sess_mock_001',
  });
}
