import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJsonBody } from '../body-parser.js';
import { extractToken, setupCredentials } from '../credentials.js';
import { BadRequestError, InternalError } from '../errors.js';
import { spawnWithQueue } from '../queue.js';
import { ClaudeStreamParser, type ClaudeEvent } from '../stream-parser.js';
import { initSSE, sendSSE, endSSE, sendJSON } from '../sse.js';
import { log } from '../logger.js';
import { trackSession, completeSession, touchSession, renameSession, getClaudeSessionId } from '../sessions.js';
import { recordUsage } from '../db.js';
import { validateModel, validateSessionId } from '../validate.js';

interface ChatRequest {
  message: string;
  session_id?: string;
  model?: string;
  system_prompt?: string;
  context_md?: string;
  mcp_config?: Record<string, unknown>;
  max_turns?: number;
  max_timeout?: number;
  allow_network?: boolean;
  stream?: boolean;
}

export async function chatHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = extractToken(req.headers.authorization);
  const { paths, userHash } = await setupCredentials(token);

  const body = await parseJsonBody<ChatRequest>(req);
  if (!body.message || typeof body.message !== 'string') {
    throw new BadRequestError('message is required and must be a string');
  }

  validateSessionId(body.session_id);
  const isNewSession = !body.session_id;
  // Client's session_id — whatever they send, we accept as their key
  const clientSessionId = body.session_id || `sess_${randomUUID().replace(/-/g, '')}`;
  const model = validateModel(body.model);
  const streaming = body.stream !== false;

  if (isNewSession) {
    trackSession(clientSessionId, userHash, model);
    log('info', 'New chat session', { clientSessionId, userHash, model });
  } else {
    touchSession(clientSessionId);
  }

  // Resolve Claude's real session_id for --continue
  const claudeSessionId = isNewSession ? undefined : getClaudeSessionId(clientSessionId);

  // MCP config: write to user's home dir (stable path)
  let mcpConfigPath: string | undefined;
  if (body.mcp_config) {
    mcpConfigPath = join(paths.home, 'mcp-config.json');
    await writeFile(mcpConfigPath, JSON.stringify(body.mcp_config), { encoding: 'utf-8', mode: 0o600 });
  }

  // CLAUDE.md: write to user's files dir (stable cwd)
  if (isNewSession && body.context_md) {
    await writeFile(join(paths.files, 'CLAUDE.md'), body.context_md, 'utf-8');
  }

  log('info', 'Chat session resolved', {
    clientSessionId,
    claudeSessionId: claudeSessionId || '(new)',
    hasMcpConfig: !!body.mcp_config,
    cwd: paths.files,
  });

  // cwd = user's files dir (STABLE — never changes, so Claude Code can find sessions)
  const { process: proc, cleanup } = await spawnWithQueue({
    prompt: body.message,
    userPaths: paths,
    userHash,
    model,
    systemPrompt: body.system_prompt,
    sessionId: claudeSessionId,
    maxTurns: body.max_turns ?? 50,
    timeoutMs: body.max_timeout,
    mcpConfigPath,
    allowNetwork: body.allow_network,
  });

  const requestStartTime = Date.now();
  let processFinished = false;
  proc.on('close', () => { processFinished = true; });

  res.on('close', () => {
    if (processFinished) {
      // Process already done — clean up immediately
      cleanup();
      return;
    }
    log('info', 'Client disconnected — process continues in background', {
      userHash, sessionId: claudeSessionId || clientSessionId,
      durationMs: Date.now() - requestStartTime, pid: proc.pid,
    });
    // Let the process finish so the session saves.
    // Safety timeout kills orphaned processes after 10 min.
    const safetyTimer = setTimeout(() => cleanup(), 10 * 60 * 1000);
    safetyTimer.unref(); // don't block process exit
  });

  if (!proc.stdout) {
    cleanup();
    completeSession(clientSessionId, 'error');
    throw new InternalError('Claude process has no stdout');
  }

  const parser = new ClaudeStreamParser();
  proc.stdout.pipe(parser);

  if (streaming) {
    initSSE(res);

    parser.on('data', (event: ClaudeEvent) => {
      sendSSE(res, event.type, event);
      if (event.type === 'result' && event.session_id) {
        // Map client's ID → Claude's real ID (for future --continue)
        renameSession(clientSessionId, event.session_id);
        // Return client's session_id — not Claude's internal ID
        sendSSE(res, 'session', {
          type: 'session',
          session_id: clientSessionId,
        });
      }
    });

    parser.on('end', () => {
      completeSession(clientSessionId);
      endSSE(res);
      cleanup();
    });

    parser.on('error', (err) => {
      log('error', 'Chat stream error', { error: err.message, userHash, clientSessionId });
      completeSession(clientSessionId, 'error');
      endSSE(res);
      cleanup();
    });

    proc.on('error', (err) => {
      log('error', 'Chat process error', { error: err.message, userHash, clientSessionId });
      completeSession(clientSessionId, 'error');
      endSSE(res);
      cleanup();
    });
  } else {
    const events: ClaudeEvent[] = [];

    parser.on('data', (event: ClaudeEvent) => events.push(event));

    parser.on('end', () => {
      cleanup();

      let text = '';
      let usage = { input_tokens: 0, output_tokens: 0 };
      let costUsd = 0;
      let durationMs = 0;

      for (const ev of events) {
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) text = block.text;
          }
        }
        if (ev.type === 'result') {
          if (ev.session_id) {
            renameSession(clientSessionId, ev.session_id);
          }
          if (ev.usage) usage = { input_tokens: ev.usage.input_tokens ?? 0, output_tokens: ev.usage.output_tokens ?? 0 };
          if (ev.total_cost_usd) costUsd = ev.total_cost_usd;
          if (ev.duration_ms) durationMs = ev.duration_ms;
        }
      }

      completeSession(clientSessionId);
      recordUsage({ userHash, endpoint: '/chat', model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, costUsd: costUsd, durationMs: durationMs, sessionId: clientSessionId });

      sendJSON(res, 200, {
        session_id: clientSessionId,
        message: text,
        usage,
      });
    });

    parser.on('error', (err) => {
      cleanup();
      completeSession(clientSessionId, 'error');
      log('error', 'Chat stream error (non-stream)', { error: err.message });
      if (!res.headersSent) {
        sendJSON(res, 500, { error: { type: 'api_error', message: 'Chat processing failed' } });
      }
    });
  }
}
