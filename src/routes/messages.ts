import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody } from '../body-parser.js';
import { extractToken, setupCredentials } from '../credentials.js';
import { BadRequestError, InternalError } from '../errors.js';
import { spawnWithQueue } from '../queue.js';
import { ClaudeStreamParser, type ClaudeEvent } from '../stream-parser.js';
import { AnthropicTranslator } from '../anthropic-translator.js';
import { initSSE, sendJSON } from '../sse.js';
import { log } from '../logger.js';
import { recordUsage } from '../db.js';
import { validateModel } from '../validate.js';

// ── Request types ─────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  source?: unknown;
}

interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

interface MessagesRequest {
  model?: string;
  max_tokens?: number;
  messages: Message[];
  system?: string | Array<{ type: string; text: string }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  metadata?: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('\n');
}

function extractSystemPrompt(system: MessagesRequest['system']): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n');
  }
  return undefined;
}

/**
 * Convert a messages array into a single prompt string for `claude -p`.
 * Single user message → use directly.
 * Multi-turn → serialize as conversation transcript.
 */
function messagesToPrompt(messages: Message[]): string {
  if (messages.length === 0) throw new BadRequestError('messages array is empty');

  // Single user message — pass directly
  if (messages.length === 1) {
    return extractText(messages[0].content);
  }

  // Multi-turn — format as transcript
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'Human' : 'Assistant';
    const text = extractText(msg.content);
    lines.push(`${role}: ${text}`);
  }
  return lines.join('\n\n');
}

// ── Handler ───────────────────────────────────────────────────────

export async function messagesHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Auth
  const token = extractToken(req.headers.authorization);
  const { paths, userHash } = await setupCredentials(token);

  // Parse body
  const body = await parseJsonBody<MessagesRequest>(req);

  // Validate
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new BadRequestError('messages is required and must be a non-empty array');
  }

  const prompt = messagesToPrompt(body.messages);
  const model = validateModel(body.model);
  const systemPrompt = extractSystemPrompt(body.system);
  const streaming = body.stream !== false; // default true for Provider mode

  // Spawn claude process — Provider mode: single turn, no filesystem
  const { process: proc, cleanup } = await spawnWithQueue({
    prompt,
    userPaths: paths,
    userHash,
    model,
    systemPrompt,
    maxTurns: 1,
    noFileAccess: true,
  });

  // Handle client disconnect
  res.on('close', () => {
    cleanup();
  });

  if (!proc.stdout) {
    cleanup();
    throw new InternalError('Claude process has no stdout');
  }

  const parser = new ClaudeStreamParser();
  proc.stdout.pipe(parser);

  if (streaming) {
    // ── Streaming mode: SSE ──
    initSSE(res);
    const translator = new AnthropicTranslator(res, model);

    parser.on('data', (event: ClaudeEvent) => {
      translator.handleEvent(event);
    });

    parser.on('end', () => {
      translator.end();
      recordUsage({ userHash, endpoint: '/v1/messages', model, inputTokens: translator.usage.input_tokens, outputTokens: translator.usage.output_tokens, costUsd: translator.cost, durationMs: translator.duration });
      cleanup();
    });

    parser.on('error', (err) => {
      log('error', 'Stream parser error', { error: err.message, userHash });
      translator.end();
      cleanup();
    });

    proc.on('error', (err) => {
      log('error', 'Claude process error', { error: err.message, userHash });
      translator.end();
      cleanup();
    });
  } else {
    // ── Non-streaming mode: collect and return JSON ──
    const events: ClaudeEvent[] = [];

    parser.on('data', (event: ClaudeEvent) => {
      events.push(event);
    });

    parser.on('end', () => {
      cleanup();

      // Extract text from all events
      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd = 0;
      let durationMs = 0;

      for (const ev of events) {
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) {
              text = block.text;
            }
          }
          if (ev.message.usage) {
            if (ev.message.usage.input_tokens) inputTokens = ev.message.usage.input_tokens;
            if (ev.message.usage.output_tokens) outputTokens = ev.message.usage.output_tokens;
          }
        }
        if (ev.type === 'content_block_delta' && ev.delta?.text) {
          text += ev.delta.text;
        }
        if (ev.type === 'result') {
          if (ev.usage?.input_tokens) inputTokens = ev.usage.input_tokens;
          if (ev.usage?.output_tokens) outputTokens = ev.usage.output_tokens;
          if (ev.total_cost_usd) costUsd = ev.total_cost_usd;
          if (ev.duration_ms) durationMs = ev.duration_ms;
        }
      }

      recordUsage({ userHash, endpoint: '/v1/messages', model, inputTokens, outputTokens, costUsd, durationMs });

      sendJSON(res, 200, {
        id: `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
        model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });
    });

    parser.on('error', (err) => {
      cleanup();
      log('error', 'Stream parser error (non-stream)', { error: err.message, userHash });
      if (!res.headersSent) {
        sendJSON(res, 500, { error: { type: 'api_error', message: 'Stream processing failed' } });
      }
    });

    proc.on('error', (err) => {
      cleanup();
      log('error', 'Claude process error (non-stream)', { error: err.message, userHash });
      if (!res.headersSent) {
        sendJSON(res, 500, { error: { type: 'api_error', message: `Claude process failed: ${err.message}` } });
      }
    });
  }
}
