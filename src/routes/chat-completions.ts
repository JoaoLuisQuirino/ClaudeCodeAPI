import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody } from '../body-parser.js';
import { extractToken, setupCredentials } from '../credentials.js';
import { BadRequestError, InternalError } from '../errors.js';
import { spawnWithQueue } from '../queue.js';
import { ClaudeStreamParser, type ClaudeEvent } from '../stream-parser.js';
import { OpenAITranslator } from '../openai-translator.js';
import { initSSE, sendJSON } from '../sse.js';
import { log } from '../logger.js';
import { randomUUID } from 'node:crypto';
import { recordUsage } from '../db.js';

// ── Request types ─────────────────────────────────────────────────

interface OAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionsRequest {
  model?: string;
  messages: OAIMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  n?: number;
}

// ── Helpers ───────────────────────────────────────────────────────

function mapModel(model: string | undefined): string {
  if (!model) return 'sonnet';
  // Accept OpenAI model names and map to Claude
  const m = model.toLowerCase();
  if (m.includes('opus') || m === 'gpt-4' || m === 'gpt-4o') return 'opus';
  if (m.includes('haiku') || m === 'gpt-3.5-turbo' || m === 'gpt-4o-mini') return 'haiku';
  if (m.includes('sonnet') || m.includes('claude')) return 'sonnet';
  return model; // pass through to claude binary
}

function messagesToPrompt(messages: OAIMessage[]): { prompt: string; systemPrompt?: string } {
  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  const systemPrompt = systemMsgs.length > 0
    ? systemMsgs.map(m => m.content).join('\n')
    : undefined;

  if (nonSystem.length === 0) {
    return { prompt: systemPrompt || '', systemPrompt: undefined };
  }
  if (nonSystem.length === 1) {
    return { prompt: nonSystem[0].content, systemPrompt };
  }

  // Multi-turn
  const lines = nonSystem.map(m => {
    const role = m.role === 'user' ? 'Human' : 'Assistant';
    return `${role}: ${m.content}`;
  });
  return { prompt: lines.join('\n\n'), systemPrompt };
}

// ── Handler ───────────────────────────────────────────────────────

export async function chatCompletionsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = extractToken(req.headers.authorization);
  const { paths, userHash } = await setupCredentials(token);

  const body = await parseJsonBody<ChatCompletionsRequest>(req);
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new BadRequestError('messages is required and must be a non-empty array');
  }

  const model = mapModel(body.model);
  const { prompt, systemPrompt } = messagesToPrompt(body.messages);
  const streaming = body.stream === true; // OpenAI default is non-streaming

  const { process: proc, cleanup } = await spawnWithQueue({
    prompt,
    userPaths: paths,
    userHash,
    model,
    systemPrompt,
    maxTurns: 1,
    bare: true,
  });

  res.on('close', () => cleanup());

  if (!proc.stdout) {
    cleanup();
    throw new InternalError('Claude process has no stdout');
  }

  const parser = new ClaudeStreamParser();
  proc.stdout.pipe(parser);

  if (streaming) {
    initSSE(res);
    const translator = new OpenAITranslator(res, model);

    parser.on('data', (event: ClaudeEvent) => translator.handleEvent(event));
    parser.on('end', () => {
      recordUsage({ userHash, endpoint: '/v1/chat/completions', model, inputTokens: translator.usage.prompt_tokens, outputTokens: translator.usage.completion_tokens, costUsd: 0, durationMs: 0 });
      translator.end();
      cleanup();
    });
    parser.on('error', (err) => {
      log('error', 'OpenAI stream error', { error: err.message, userHash });
      translator.end();
      cleanup();
    });
    proc.on('error', (err) => {
      log('error', 'OpenAI process error', { error: err.message, userHash });
      translator.end();
      cleanup();
    });
  } else {
    // Non-streaming: collect events, build OpenAI response
    const events: ClaudeEvent[] = [];

    parser.on('data', (event: ClaudeEvent) => events.push(event));

    parser.on('end', () => {
      cleanup();

      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;

      for (const ev of events) {
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) text = block.text;
          }
        }
        if (ev.type === 'content_block_delta' && ev.delta?.text) {
          text += ev.delta.text;
        }
        if (ev.type === 'result' && ev.usage) {
          if (ev.usage.input_tokens) inputTokens = ev.usage.input_tokens;
          if (ev.usage.output_tokens) outputTokens = ev.usage.output_tokens;
        }
      }

      recordUsage({ userHash, endpoint: '/v1/chat/completions', model, inputTokens, outputTokens, costUsd: 0, durationMs: 0 });

      const modelName = model.includes('opus') ? 'claude-opus-4-6'
        : model.includes('haiku') ? 'claude-haiku-4-5'
        : 'claude-sonnet-4-6';

      sendJSON(res, 200, {
        id: `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      });
    });

    parser.on('error', (err) => {
      cleanup();
      log('error', 'OpenAI stream error (non-stream)', { error: err.message, userHash });
      if (!res.headersSent) {
        sendJSON(res, 500, { error: { type: 'api_error', message: 'Processing failed' } });
      }
    });
  }
}
