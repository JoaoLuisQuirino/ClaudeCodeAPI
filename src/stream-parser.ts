import { Transform, TransformCallback } from 'node:stream';

/**
 * Typed event from claude CLI --output-format stream-json.
 * The CLI emits NDJSON lines with these known types.
 */
export interface ClaudeEvent {
  type: string;
  subtype?: string;

  // "assistant" events
  message?: {
    id?: string;
    type?: string;
    role?: string;
    model?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
    content?: ContentBlock[];
    usage?: TokenUsage;
  };

  // "content_block_start" / "content_block_stop"
  index?: number;
  content_block?: ContentBlock;

  // "content_block_delta"
  delta?: {
    type: string;
    text?: string;
  };

  // "tool_use" top-level
  name?: string;
  input?: unknown;
  tool_use_id?: string;

  // "tool_result" top-level
  content?: string;

  // "result" event
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: TokenUsage;
  session_id?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Transform stream: raw bytes from claude stdout → parsed ClaudeEvent objects.
 *
 * - Buffers partial lines (NDJSON may arrive in arbitrary chunks)
 * - Silently skips non-JSON lines (debug output, warnings)
 * - Emits in objectMode for downstream consumers
 */
export class ClaudeStreamParser extends Transform {
  private buf = '';

  constructor() {
    super({ readableObjectMode: true, writableObjectMode: false });
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.buf += chunk.toString('utf-8');
    this.drainLines();
    cb();
  }

  override _flush(cb: TransformCallback): void {
    // Process any remaining data without a trailing newline
    if (this.buf.length > 0) {
      this.parseLine(this.buf);
      this.buf = '';
    }
    cb();
  }

  private drainLines(): void {
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      this.parseLine(line);
    }
  }

  private parseLine(raw: string): void {
    const line = raw.trim();
    if (line.length === 0) return;
    try {
      const obj: unknown = JSON.parse(line);
      if (obj && typeof obj === 'object' && 'type' in obj && typeof (obj as ClaudeEvent).type === 'string') {
        this.push(obj as ClaudeEvent);
      }
    } catch {
      // Non-JSON line — ignore (debug output, binary preamble, etc.)
    }
  }
}
