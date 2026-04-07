import { spawn, ChildProcess } from 'node:child_process';
import { config } from './config.js';
import { log } from './logger.js';
import { InternalError } from './errors.js';
import type { SpawnClaudeOpts, SpawnResult } from './claude-spawn.js';

/**
 * Check if Docker is available on this system.
 * Caches result after first check.
 */
let _dockerAvailable: boolean | null = null;

export async function isDockerAvailable(): Promise<boolean> {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    const proc = spawn('docker', ['info'], { stdio: 'ignore' });
    return new Promise((resolve) => {
      proc.on('close', (code) => {
        _dockerAvailable = code === 0;
        resolve(_dockerAvailable);
      });
      proc.on('error', () => {
        _dockerAvailable = false;
        resolve(false);
      });
    });
  } catch {
    _dockerAvailable = false;
    return false;
  }
}

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'claudecodeapi/sandbox:latest';

/**
 * Spawn claude inside an isolated Docker container.
 *
 * Container isolation:
 * - Volume mounts: only user's home and files dirs
 * - Network: none (no outbound access)
 * - Memory: capped at 512MB
 * - CPU: limited to 1 core
 * - Filesystem: read-only except /home/claude and /workspace
 * - Runs as non-root user
 */
export function spawnClaudeDocker(opts: SpawnClaudeOpts): SpawnResult {
  const claudeArgs: string[] = [
    '-p', opts.prompt,
    '--output-format', 'stream-json',
    '--model', opts.model || config.defaultModel,
    '--permission-mode', 'bypassPermissions',
  ];

  if (opts.bare) claudeArgs.push('--bare');
  if (opts.sessionId) claudeArgs.push('--continue', opts.sessionId);
  if (opts.systemPrompt) claudeArgs.push('--system-prompt', opts.systemPrompt);
  if (opts.maxTurns != null && opts.maxTurns > 0) claudeArgs.push('--max-turns', String(opts.maxTurns));
  claudeArgs.push('--add-dir', '/workspace');
  if (opts.extraArgs) claudeArgs.push(...opts.extraArgs);

  const dockerArgs: string[] = [
    'run', '--rm',
    // Isolation
    '--network', 'none',
    '--memory', '512m',
    '--cpus', '1',
    '--read-only',
    // Tmpfs for transient writes
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=100m',
    // Volume mounts — user-specific
    '-v', `${opts.userPaths.home}:/home/claude`,
    '-v', `${opts.userPaths.files}:/workspace`,
    // Environment
    '-e', 'HOME=/home/claude',
    '-e', 'CI=1',
    // Image
    SANDBOX_IMAGE,
    // Claude args
    ...claudeArgs,
  ];

  // MCP config mount
  if (opts.mcpConfigPath) {
    // Insert before the image name
    const imgIdx = dockerArgs.indexOf(SANDBOX_IMAGE);
    dockerArgs.splice(imgIdx, 0, '-v', `${opts.mcpConfigPath}:/home/claude/mcp-config.json:ro`);
    claudeArgs.push('--mcp-config', '/home/claude/mcp-config.json');
  }

  let proc: ChildProcess;
  try {
    proc = spawn('docker', dockerArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    throw new InternalError(`Failed to spawn docker: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Stderr collection
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
    if (stderr.length > 8192) stderr = stderr.slice(-4096);
  });

  // Timeout
  const timer = setTimeout(() => {
    log('warn', 'Docker container timeout — killing', { userHash: opts.userHash });
    proc.kill('SIGTERM');
    setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
  }, config.processTimeoutMs);

  proc.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0 && code !== null) {
      log('error', 'Docker container exited with error', {
        code,
        stderr: stderr.slice(0, 500),
        userHash: opts.userHash,
      });
    }
  });

  log('info', 'Spawned claude in Docker container', {
    userHash: opts.userHash,
    model: opts.model || config.defaultModel,
    image: SANDBOX_IMAGE,
  });

  const cleanup = () => {
    clearTimeout(timer);
    if (!proc.killed) proc.kill('SIGTERM');
  };

  return { process: proc, cleanup };
}
