import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { extractToken, setupCredentials } from '../credentials.js';
import { NotFoundError } from '../errors.js';
import { sendJSON } from '../sse.js';
import { log } from '../logger.js';

export async function listFilesHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = extractToken(req.headers.authorization);
  const { paths } = await setupCredentials(token);

  let entries: string[];
  try {
    entries = await readdir(paths.files);
  } catch {
    entries = [];
  }

  const files: Array<{ name: string; size: number; modified: string }> = [];
  for (const name of entries) {
    try {
      const s = await stat(join(paths.files, name));
      if (s.isFile()) {
        files.push({
          name,
          size: s.size,
          modified: s.mtime.toISOString(),
        });
      }
    } catch {
      // skip unreadable files
    }
  }

  sendJSON(res, 200, { files });
}

export async function deleteFileHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const token = extractToken(req.headers.authorization);
  const { paths, userHash } = await setupCredentials(token);

  const fileName = params.name;
  // Prevent directory traversal
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    throw new NotFoundError('Invalid file name');
  }

  const filePath = join(paths.files, fileName);
  try {
    await unlink(filePath);
    log('info', 'File deleted', { userHash, fileName });
    sendJSON(res, 200, { deleted: true, name: fileName });
  } catch {
    throw new NotFoundError(`File "${fileName}" not found`);
  }
}
