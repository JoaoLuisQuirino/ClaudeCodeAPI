import { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sendSSE, endSSE } from './sse.js';
import type { ClaudeEvent } from './stream-parser.js';

/**
 * Translates ClaudeEvent stream → OpenAI Chat Completions SSE format.
 *
 * OpenAI streaming format:
 *   data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234,"model":"...","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}
 *   data: [DONE]
 */
export class OpenAITranslator {
  private id: string;
  private model: string;
  private res: ServerResponse;
  private created: number;
  private started = false;
  private prevTextLen = 0;
  private textBuf = '';
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(res: ServerResponse, model: string) {
    this.res = res;
    this.model = mapModel(model);
    this.id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    this.created = Math.floor(Date.now() / 1000);
  }

  get accumulatedText(): string { return this.textBuf; }
  get usage(): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
    return {
      prompt_tokens: this.inputTokens,
      completion_tokens: this.outputTokens,
      total_tokens: this.inputTokens + this.outputTokens,
    };
  }
  get completionId(): string { return this.id; }

  private emitChunk(content?: string, role?: string, finishReason: string | null = null): void {
    if (this.res.destroyed || this.res.writableEnded) return;

    const delta: Record<string, string> = {};
    if (role) delta.role = role;
    if (content) delta.content = content;

    const chunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason,
      }],
    };

    sendSSE(this.res, 'message', chunk);
  }

  handleEvent(event: ClaudeEvent): void {
    if (this.res.destroyed || this.res.writableEnded) return;

    switch (event.type) {
      case 'assistant': {
        if (!this.started) {
          this.started = true;
          this.emitChunk(undefined, 'assistant');
        }
        const blocks = event.message?.content;
        if (!Array.isArray(blocks)) break;
        for (const block of blocks) {
          if (block.type === 'text' && typeof block.text === 'string') {
            const full = block.text;
            if (full.length > this.prevTextLen) {
              const delta = full.slice(this.prevTextLen);
              this.prevTextLen = full.length;
              this.textBuf += delta;
              this.emitChunk(delta);
            } else if (this.prevTextLen === 0 && full.length > 0) {
              this.prevTextLen = full.length;
              this.textBuf += full;
              this.emitChunk(full);
            }
          }
        }
        if (event.message?.usage) {
          if (event.message.usage.input_tokens) this.inputTokens = event.message.usage.input_tokens;
          if (event.message.usage.output_tokens) this.outputTokens = event.message.usage.output_tokens;
        }
        break;
      }

      case 'content_block_start': {
        if (!this.started) {
          this.started = true;
          this.emitChunk(undefined, 'assistant');
        }
        break;
      }

      case 'content_block_delta': {
        if (!this.started) {
          this.started = true;
          this.emitChunk(undefined, 'assistant');
        }
        const text = event.delta?.text;
        if (text) {
          this.textBuf += text;
          this.emitChunk(text);
        }
        break;
      }

      case 'result': {
        if (event.usage) {
          if (event.usage.input_tokens) this.inputTokens = event.usage.input_tokens;
          if (event.usage.output_tokens) this.outputTokens = event.usage.output_tokens;
        }
        break;
      }

      // Skip non-text events
      case 'content_block_stop':
      case 'tool_use':
      case 'tool_result':
      default:
        break;
    }
  }

  end(): void {
    if (this.res.destroyed || this.res.writableEnded) return;

    if (!this.started) {
      this.emitChunk(undefined, 'assistant');
    }

    // Final chunk with finish_reason
    this.emitChunk(undefined, undefined, 'stop');

    // Send [DONE]
    if (!this.res.destroyed && !this.res.writableEnded) {
      this.res.write('data: [DONE]\n\n');
    }
    endSSE(this.res);
  }
}

/** Map claude model names to OpenAI-style names for compatibility. */
function mapModel(model: string): string {
  if (model.includes('opus')) return 'claude-opus-4-6';
  if (model.includes('sonnet')) return 'claude-sonnet-4-6';
  if (model.includes('haiku')) return 'claude-haiku-4-5';
  return model;
}
