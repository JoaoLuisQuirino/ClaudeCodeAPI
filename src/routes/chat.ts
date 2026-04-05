import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseJsonBody } from '../body-parser.js';
import { extractToken, setupCredentials } from '../credentials.js';
import { BadRequestError, InternalError } from '../errors.js';
import { spawnWithQueue } from '../queue.js';
import { ClaudeStreamParser, type ClaudeEvent } from '../stream-parser.js';
import { initSSE, sendSSE, endSSE, sendJSON } from '../sse.js';
import { log } from '../logger.js';
import { trackSession, completeSession, touchSession, renameSession } from '../sessions.js';
import { recordUsage } from '../db.js';

interface ChatRequest {
  message: string;
  session_id?: string;
  model?: string;
  system_prompt?: string;
  max_turns?: number;
  stream?: boolean;
}

export async function chatHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = extractToken(req.headers.authorization);
  const { paths, userHash } = await setupCredentials(token);

  const body = await parseJsonBody<ChatRequest>(req);
  if (!body.message || typeof body.message !== 'string') {
    throw new BadRequestError('message is required and must be a string');
  }

  const isNewSession = !body.session_id;
  const sessionId = body.session_id || `sess_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const model = body.model || 'sonnet';
  const streaming = body.stream !== false;

  if (isNewSession) {
    trackSession(sessionId, userHash, model);
  } else {
    touchSession(sessionId);
  }

  const { process: proc, cleanup } = await spawnWithQueue({
    prompt: body.message,
    userPaths: paths,
    userHash,
    model,
    systemPrompt: body.system_prompt,
    sessionId: body.session_id, // --continue for existing sessions
    maxTurns: body.max_turns ?? 50,
  });

  res.on('close', () => cleanup());

  if (!proc.stdout) {
    cleanup();
    completeSession(sessionId, 'error');
    throw new InternalError('Claude process has no stdout');
  }

  const parser = new ClaudeStreamParser();
  proc.stdout.pipe(parser);

  if (streaming) {
    initSSE(res);

    parser.on('data', (event: ClaudeEvent) => {
      sendSSE(res, event.type, event);
      if (event.type === 'result' && event.session_id) {
        renameSession(sessionId, event.session_id);
        sendSSE(res, 'session', {
          type: 'session',
          session_id: event.session_id,
        });
      }
    });

    parser.on('end', () => {
      completeSession(sessionId);
      endSSE(res);
      cleanup();
    });

    parser.on('error', (err) => {
      log('error', 'Chat stream error', { error: err.message, userHash, sessionId });
      completeSession(sessionId, 'error');
      endSSE(res);
      cleanup();
    });

    proc.on('error', (err) => {
      log('error', 'Chat process error', { error: err.message, userHash, sessionId });
      completeSession(sessionId, 'error');
      endSSE(res);
      cleanup();
    });
  } else {
    const events: ClaudeEvent[] = [];

    parser.on('data', (event: ClaudeEvent) => events.push(event));

    parser.on('end', () => {
      cleanup();

      let text = '';
      let realSessionId = sessionId;
      let usage = { input_tokens: 0, output_tokens: 0 };

      for (const ev of events) {
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) text = block.text;
          }
        }
        if (ev.type === 'result') {
          if (ev.session_id) {
            realSessionId = ev.session_id;
            renameSession(sessionId, ev.session_id);
          }
          if (ev.usage) usage = { input_tokens: ev.usage.input_tokens ?? 0, output_tokens: ev.usage.output_tokens ?? 0 };
        }
      }

      completeSession(realSessionId);
      recordUsage({ userHash, endpoint: '/chat', model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, costUsd: 0, durationMs: 0, sessionId: realSessionId });

      sendJSON(res, 200, {
        session_id: realSessionId,
        message: text,
        usage,
      });
    });

    parser.on('error', (err) => {
      cleanup();
      completeSession(sessionId, 'error');
      log('error', 'Chat stream error (non-stream)', { error: err.message });
      if (!res.headersSent) {
        sendJSON(res, 500, { error: { type: 'api_error', message: 'Chat processing failed' } });
      }
    });
  }
}
