import { spawn, ChildProcess } from 'node:child_process';
import { config } from './config.js';
import { log } from './logger.js';
// errors imported for potential future use by callers
import type { UserPaths } from './credentials.js';

// ── Spawn options ─────────────────────────────────────────────────

export interface SpawnClaudeOpts {
  prompt: string;
  userPaths: UserPaths;
  userHash: string;
  model?: string;
  sessionId?: string;       // --continue
  systemPrompt?: string;    // --system-prompt
  mcpConfigPath?: string;   // --mcp-config
  maxTurns?: number;        // --max-turns (omit for Provider mode)
  bare?: boolean;           // --bare (fast startup, no hooks)
  addDirs?: string[];       // extra --add-dir entries
  extraArgs?: string[];     // passthrough flags
}

export interface SpawnResult {
  process: ChildProcess;
  /** Call once when you're done — kills process if alive. */
  cleanup: () => void;
}

// ── Spawn (pure — no concurrency logic) ───────────────────────────

/**
 * Spawn a claude process. This is a pure spawn function with no
 * concurrency control. Use `spawnWithQueue` from queue.ts for
 * queue-aware spawning.
 */
export function spawnClaude(opts: SpawnClaudeOpts): SpawnResult {
  const args: string[] = [
    ...config.claudePrependArgs,
    '-p', opts.prompt,
    '--output-format', 'stream-json',
    '--model', opts.model || config.defaultModel,
    '--permission-mode', 'bypassPermissions',
  ];

  if (opts.bare) args.push('--bare');
  if (opts.sessionId) args.push('--continue', opts.sessionId);
  if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);
  if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath);
  if (opts.maxTurns != null && opts.maxTurns > 0) args.push('--max-turns', String(opts.maxTurns));

  // File access directories
  args.push('--add-dir', opts.userPaths.files);
  if (opts.addDirs) {
    for (const d of opts.addDirs) args.push('--add-dir', d);
  }

  if (opts.extraArgs) args.push(...opts.extraArgs);

  const proc = spawn(config.claudeBinary, args, {
    env: {
      ...process.env,
      HOME: opts.userPaths.home,
      DISPLAY: '',
      BROWSER: '',
      CI: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.userPaths.files,
    windowsHide: true,
  });

  // ── stderr collection (bounded) ──
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
    if (stderr.length > 8192) stderr = stderr.slice(-4096);
  });

  // ── timeout ──
  const timer = setTimeout(() => {
    log('warn', 'Claude process timeout — killing', { pid: proc.pid, userHash: opts.userHash });
    proc.kill('SIGTERM');
    setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
  }, config.processTimeoutMs);

  // ── log on exit ──
  proc.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0 && code !== null) {
      log('error', 'Claude process exited with error', {
        pid: proc.pid, code,
        stderr: stderr.slice(0, 500),
        userHash: opts.userHash,
      });
    }
  });

  log('info', 'Spawned claude process', {
    pid: proc.pid,
    userHash: opts.userHash,
    model: opts.model || config.defaultModel,
    sessionId: opts.sessionId,
  });

  const cleanup = () => {
    clearTimeout(timer);
    if (!proc.killed) proc.kill('SIGTERM');
  };

  return { process: proc, cleanup };
}
