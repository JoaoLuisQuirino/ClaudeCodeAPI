import { spawn, ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';
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
  noFileAccess?: boolean;   // skip --add-dir (Provider mode: no filesystem access)
  allowNetwork?: boolean;   // enable network in Docker container (default: none)
  timeoutMs?: number;       // per-request timeout override (0 = no timeout, undefined = use global)
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
  const isResume = !!opts.sessionId;

  const claudeArgs: string[] = [
    '--output-format', 'stream-json',
    '--verbose',
    '--model', opts.model || config.defaultModel,
    '--permission-mode', 'bypassPermissions',
  ];

  if (isResume) {
    // --resume ignores -p, so we'll send the prompt via stdin
    claudeArgs.push('--resume', opts.sessionId!);
    log('info', 'Session resume', {
      sessionId: opts.sessionId,
      userHash: opts.userHash,
      home: opts.userPaths.home,
      cwd: opts.userPaths.files,
      promptLength: opts.prompt.length,
    });
  } else {
    // New session: use -p for the prompt
    claudeArgs.push('-p', opts.prompt);
  }

  if (opts.bare) claudeArgs.push('--bare');
  if (opts.systemPrompt) claudeArgs.push('--system-prompt', opts.systemPrompt);
  if (opts.maxTurns != null && opts.maxTurns > 0) claudeArgs.push('--max-turns', String(opts.maxTurns));

  // File access: user's files dir as working directory
  const hostWorkDir = opts.userPaths.files;
  if (!opts.noFileAccess) {
    const workspaceDir = config.dockerIsolation ? '/workspace' : hostWorkDir;
    claudeArgs.push('--add-dir', workspaceDir);
    if (opts.addDirs && !config.dockerIsolation) {
      for (const d of opts.addDirs) claudeArgs.push('--add-dir', d);
    }
  }

  // MCP config path (inside container: /workspace/mcp.json)
  if (opts.mcpConfigPath) {
    if (config.dockerIsolation) {
      claudeArgs.push('--mcp-config', '/workspace/mcp.json');
    } else {
      claudeArgs.push('--mcp-config', opts.mcpConfigPath);
    }
  }

  if (opts.extraArgs) claudeArgs.push(...opts.extraArgs);

  let proc: ChildProcess;

  if (config.dockerIsolation) {
    // Docker-isolated spawn: each request runs in its own container
    const homePath = resolve(opts.userPaths.home);
    const filesPath = resolve(opts.userPaths.files);

    const dockerArgs = [
      'run', '--rm',
      ...(isResume ? ['-i'] : []), // stdin forwarding for prompt via pipe
      // Resource limits
      '--memory', config.dockerMemory,
      '--cpus', config.dockerCpus,
      // Network: bridge by default (Claude CLI needs internet for API calls)
      '--network', 'bridge',
      // Read-only root filesystem — can only write to mounted volumes
      '--read-only',
      // Tmpfs for claude's runtime needs
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      // Mount ONLY this user's directories
      '-v', `${homePath}:/home/claude:rw`,
      '-v', `${filesPath}:/workspace:rw`,
      // Set home for claude binary
      '-e', 'HOME=/home/claude',
      '-e', 'CI=1',
      // Working directory
      '-w', '/workspace',
    ];

    dockerArgs.push(
      // Image
      config.dockerImage,
      // Claude command + args
      'claude', ...claudeArgs,
    );

    proc = spawn('docker', dockerArgs, {
      stdio: [isResume ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    log('info', 'Spawned docker-isolated claude process', {
      pid: proc.pid,
      userHash: opts.userHash,
      model: opts.model || config.defaultModel,
      memory: config.dockerMemory,
      cpus: config.dockerCpus,
      promptLength: opts.prompt.length,
    });
  } else {
    // Direct spawn (no isolation — for solo use or trusted environments)
    proc = spawn(config.claudeBinary, [
      ...config.claudePrependArgs,
      ...claudeArgs,
    ], {
      env: {
        ...process.env,
        HOME: opts.userPaths.home,
        USERPROFILE: opts.userPaths.home,
        APPDATA: join(opts.userPaths.home, 'AppData', 'Roaming'),
        DISPLAY: '',
        BROWSER: '',
        CI: '1',
      },
      stdio: [isResume ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      cwd: hostWorkDir,
      windowsHide: true,
    });
  }

  // ── send prompt via stdin for --resume (since -p is ignored) ──
  if (isResume && proc.stdin) {
    proc.stdin.write(opts.prompt + '\n');
    proc.stdin.end();
  }

  // ── stderr collection (bounded) ──
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
    if (stderr.length > 8192) stderr = stderr.slice(-4096);
  });

  // ── timeout (0 = disabled, undefined = global default) ──
  const timeout = opts.timeoutMs !== undefined ? opts.timeoutMs : config.processTimeoutMs;
  const timer = timeout > 0
    ? setTimeout(() => {
        log('warn', 'Claude process timeout — killing', { pid: proc.pid, userHash: opts.userHash });
        proc.kill('SIGTERM');
        setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
      }, timeout)
    : null;

  // ── log on exit ──
  proc.on('close', (code) => {
    if (timer) clearTimeout(timer);
    if (code !== 0 && code !== null) {
      log('error', 'Claude process exited with error', {
        pid: proc.pid, code,
        stderr: stderr.slice(0, 500),
        userHash: opts.userHash,
      });
    }
  });

  if (!config.dockerIsolation) {
    log('info', 'Spawned claude process', {
      pid: proc.pid,
      userHash: opts.userHash,
      model: opts.model || config.defaultModel,
      sessionId: opts.sessionId,
      workDir: hostWorkDir,
      mcpConfig: opts.mcpConfigPath || '(none)',
      args: claudeArgs.filter(a => a !== opts.prompt).join(' '),
    });
  }

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (!proc.killed) proc.kill('SIGTERM');
  };

  return { process: proc, cleanup };
}
