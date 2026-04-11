import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractToken, setupCredentials } from '../credentials.js';
import { BadRequestError } from '../errors.js';
import { parseMultipart } from '../multipart.js';
import { sendJSON } from '../sse.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { checkQuota } from '../quota.js';
import { validateSessionId } from '../validate.js';

export async function uploadHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = extractToken(req.headers.authorization, req.headers['x-api-key'] as string | undefined);
  const { paths, userHash } = await setupCredentials(token);

  // If session_id provided, upload to session workspace instead of global files
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const sessionId = url.searchParams.get('session_id');
  validateSessionId(sessionId ?? undefined);

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    throw new BadRequestError('Content-Type must be multipart/form-data');
  }

  const files = await parseMultipart(req, config.maxFileSizeBytes);

  if (files.length === 0) {
    throw new BadRequestError('No files in upload');
  }

  // Target directory: session workspace or global files
  const targetDir = sessionId
    ? join(paths.sessions, sessionId)
    : paths.files;

  if (sessionId) {
    await mkdir(targetDir, { recursive: true });
  }

  const results: Array<{ name: string; size: number; path: string }> = [];

  for (const file of files) {
    await checkQuota(paths.files, file.data.length);
    const destPath = join(targetDir, file.fileName);
    await writeFile(destPath, file.data);

    // Extract ZIP files automatically if unzip is available
    if (file.fileName.endsWith('.zip')) {
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('unzip', ['-o', '-d', paths.files, destPath], { timeout: 30000, stdio: 'ignore' });
      } catch { /* unzip not available or failed — keep zip as-is */ }
    }

    results.push({
      name: file.fileName,
      size: file.data.length,
      path: `/files/${file.fileName}`,
    });
    log('info', 'File uploaded', { userHash, fileName: file.fileName, size: file.data.length });
  }

  sendJSON(res, 200, { uploaded: results });
}
