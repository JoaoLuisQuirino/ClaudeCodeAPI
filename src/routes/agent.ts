import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseJsonBody } from '../body-parser.js';
import { extractToken, setupCredentials } from '../credentials.js';
import { BadRequestError, InternalError } from '../errors.js';
import { spawnWithQueue } from '../queue.js';
import { ClaudeStreamParser, type ClaudeEvent } from '../stream-parser.js';
import { initSSE, sendSSE, endSSE, sendJSON } from '../sse.js';
import { log } from '../logger.js';
import { trackSession, completeSession, renameSession } from '../sessions.js';
import { recordUsage } from '../db.js';

interface AgentRequest {
  task: string;
  session_id?: string;
  model?: string;
  system_prompt?: string;
  mcp_config?: Record<string, unknown>;
  max_turns?: number;
  stream?: boolean;
}

export async function agentHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = extractToken(req.headers.authorization);
  const { paths, userHash } = await setupCredentials(token);

  const body = await parseJsonBody<AgentRequest>(req);
  if (!body.task || typeof body.task !== 'string') {
    throw new BadRequestError('task is required and must be a string');
  }

  const sessionId = body.session_id || `sess_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const model = body.model || 'sonnet';
  const streaming = body.stream !== false;
  const maxTurns = body.max_turns ?? 50;

  // Write MCP config if provided
  let mcpConfigPath: string | undefined;
  if (body.mcp_config) {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    mcpConfigPath = join(paths.home, 'mcp-config.json');
    await writeFile(mcpConfigPath, JSON.stringify(body.mcp_config), 'utf-8');
  }

  trackSession(sessionId, userHash, model);

  const { process: proc, cleanup } = await spawnWithQueue({
    prompt: body.task,
    userPaths: paths,
    userHash,
    model,
    systemPrompt: body.system_prompt,
    mcpConfigPath,
    maxTurns,
    sessionId: body.session_id, // --continue only if user supplied existing session
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
      // Agent mode: stream ALL events (including tool use)
      sendSSE(res, event.type, event);

      // Capture session_id from result event
      if (event.type === 'result' && event.session_id) {
        renameSession(sessionId, event.session_id);
        sendSSE(res, 'session', {
          type: 'session',
          session_id: event.session_id,
          duration_ms: event.duration_ms,
          total_cost_usd: event.total_cost_usd,
          usage: event.usage,
        });
      }
    });

    parser.on('end', () => {
      completeSession(sessionId);
      endSSE(res);
      cleanup();
    });

    parser.on('error', (err) => {
      log('error', 'Agent stream error', { error: err.message, userHash, sessionId });
      completeSession(sessionId, 'error');
      endSSE(res);
      cleanup();
    });

    proc.on('error', (err) => {
      log('error', 'Agent process error', { error: err.message, userHash, sessionId });
      completeSession(sessionId, 'error');
      endSSE(res);
      cleanup();
    });
  } else {
    // Non-streaming: collect all events, return as JSON
    const events: ClaudeEvent[] = [];

    parser.on('data', (event: ClaudeEvent) => {
      events.push(event);
    });

    parser.on('end', () => {
      cleanup();

      // Build response from events
      const textParts: string[] = [];
      let lastUsage = { input_tokens: 0, output_tokens: 0 };
      let costUsd = 0;
      let durationMs = 0;
      let realSessionId = sessionId;

      for (const ev of events) {
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) {
              textParts.push(block.text);
            }
          }
        }
        if (ev.type === 'result') {
          if (ev.usage) lastUsage = { input_tokens: ev.usage.input_tokens ?? 0, output_tokens: ev.usage.output_tokens ?? 0 };
          if (ev.total_cost_usd) costUsd = ev.total_cost_usd;
          if (ev.duration_ms) durationMs = ev.duration_ms;
          if (ev.session_id) {
            realSessionId = ev.session_id;
            renameSession(sessionId, ev.session_id);
          }
        }
      }

      completeSession(realSessionId);
      recordUsage({ userHash, endpoint: '/agent', model, inputTokens: lastUsage.input_tokens, outputTokens: lastUsage.output_tokens, costUsd, durationMs, sessionId: realSessionId });

      sendJSON(res, 200, {
        session_id: realSessionId,
        result: textParts[textParts.length - 1] || '',
        events,
        usage: lastUsage,
        cost_usd: costUsd,
        duration_ms: durationMs,
      });
    });

    parser.on('error', (err) => {
      cleanup();
      completeSession(sessionId, 'error');
      log('error', 'Agent stream error (non-stream)', { error: err.message, userHash });
      if (!res.headersSent) {
        sendJSON(res, 500, { error: { type: 'api_error', message: 'Agent processing failed' } });
      }
    });
  }
}
