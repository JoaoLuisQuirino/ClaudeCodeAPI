import { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sendSSE, endSSE } from './sse.js';
import type { ClaudeEvent } from './stream-parser.js';

/**
 * Translates ClaudeEvent stream → Anthropic Messages API SSE format.
 *
 * Handles two possible CLI output patterns:
 *  A) "assistant" events with accumulated message.content (full text each time)
 *  B) "content_block_start/delta/stop" events (incremental deltas)
 *
 * In Provider mode, tool_use/tool_result events are hidden from the client.
 */
export class AnthropicTranslator {
  private msgId: string;
  private model: string;
  private res: ServerResponse;
  private started = false;
  private blockIdx = 0;
  private blockOpen = false;
  private prevTextLen = 0; // track accumulated text for pattern A
  private inputTokens = 0;
  private outputTokens = 0;
  private textBuf = ''; // accumulate text for non-streaming collection

  constructor(res: ServerResponse, model: string) {
    this.res = res;
    this.model = model;
    this.msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  }

  /** Get accumulated text (useful for non-streaming mode). */
  get accumulatedText(): string {
    return this.textBuf;
  }

  get usage(): { input_tokens: number; output_tokens: number } {
    return { input_tokens: this.inputTokens, output_tokens: this.outputTokens };
  }

  get messageId(): string {
    return this.msgId;
  }

  private emitStart(): void {
    if (this.started) return;
    this.started = true;
    sendSSE(this.res, 'message_start', {
      type: 'message_start',
      message: {
        id: this.msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    sendSSE(this.res, 'ping', { type: 'ping' });
  }

  private openBlock(): void {
    if (this.blockOpen) return;
    this.blockOpen = true;
    sendSSE(this.res, 'content_block_start', {
      type: 'content_block_start',
      index: this.blockIdx,
      content_block: { type: 'text', text: '' },
    });
  }

  private closeBlock(): void {
    if (!this.blockOpen) return;
    this.blockOpen = false;
    sendSSE(this.res, 'content_block_stop', {
      type: 'content_block_stop',
      index: this.blockIdx,
    });
    this.blockIdx++;
  }

  private emitDelta(text: string): void {
    if (!text) return;
    this.textBuf += text;
    this.emitStart();
    this.openBlock();
    sendSSE(this.res, 'content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIdx,
      delta: { type: 'text_delta', text },
    });
  }

  /** Feed a single event from the claude stream parser. */
  handleEvent(event: ClaudeEvent): void {
    if (this.res.destroyed || this.res.writableEnded) return;

    switch (event.type) {
      // ── Pattern A: full "assistant" messages ──
      case 'assistant': {
        const blocks = event.message?.content;
        if (!Array.isArray(blocks)) break;
        for (const block of blocks) {
          if (block.type === 'text' && typeof block.text === 'string') {
            // Extract delta from accumulated text
            const fullText = block.text;
            if (fullText.length > this.prevTextLen) {
              const delta = fullText.slice(this.prevTextLen);
              this.prevTextLen = fullText.length;
              this.emitDelta(delta);
            } else if (this.prevTextLen === 0 && fullText.length > 0) {
              this.prevTextLen = fullText.length;
              this.emitDelta(fullText);
            }
          }
        }
        // Capture usage if present
        if (event.message?.usage) {
          if (event.message.usage.input_tokens) this.inputTokens = event.message.usage.input_tokens;
          if (event.message.usage.output_tokens) this.outputTokens = event.message.usage.output_tokens;
        }
        break;
      }

      // ── Pattern B: incremental content blocks ──
      case 'content_block_start': {
        this.emitStart();
        this.closeBlock(); // close any prior open block
        this.blockOpen = true;
        sendSSE(this.res, 'content_block_start', {
          type: 'content_block_start',
          index: event.index ?? this.blockIdx,
          content_block: event.content_block ?? { type: 'text', text: '' },
        });
        break;
      }

      case 'content_block_delta': {
        const text = event.delta?.text;
        if (text) this.textBuf += text;
        sendSSE(this.res, 'content_block_delta', {
          type: 'content_block_delta',
          index: event.index ?? this.blockIdx,
          delta: event.delta ?? { type: 'text_delta', text: '' },
        });
        break;
      }

      case 'content_block_stop': {
        this.blockOpen = false;
        sendSSE(this.res, 'content_block_stop', {
          type: 'content_block_stop',
          index: event.index ?? this.blockIdx,
        });
        this.blockIdx++;
        break;
      }

      // ── Result event (always last) ──
      case 'result': {
        if (event.usage) {
          if (event.usage.input_tokens) this.inputTokens = event.usage.input_tokens;
          if (event.usage.output_tokens) this.outputTokens = event.usage.output_tokens;
        }
        break;
      }

      // ── Provider mode: skip tool events ──
      case 'tool_use':
      case 'tool_result':
        break;

      // ── Unknown events: skip ──
      default:
        break;
    }
  }

  /** Finalize the SSE stream: close open blocks, send message_stop. */
  end(): void {
    if (this.res.destroyed || this.res.writableEnded) return;
    this.emitStart();
    this.closeBlock();
    sendSSE(this.res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
    sendSSE(this.res, 'message_stop', { type: 'message_stop' });
    endSSE(this.res);
  }
}
