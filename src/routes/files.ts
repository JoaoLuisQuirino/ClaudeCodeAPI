import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { extractToken, setupCredentials } from '../credentials.js';
import { NotFoundError } from '../errors.js';
import { sendJSON } from '../sse.js';
import { log } from '../logger.js';

/** Resolve target directory: session workspace or global files */
function resolveFilesDir(req: IncomingMessage, paths: { files: string; sessions: string }): string {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const sessionId = url.searchParams.get('session_id');
  if (sessionId) {
    if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
      throw new NotFoundError('Invalid session_id');
    }
    return join(paths.sessions, sessionId);
  }
  return paths.files;
}

export async function listFilesHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = extractToken(req.headers.authorization, req.headers['x-api-key'] as string | undefined);
  const { paths } = await setupCredentials(token);
  const filesDir = resolveFilesDir(req, paths);

  let entries: string[];
  try {
    entries = await readdir(filesDir);
  } catch {
    entries = [];
  }

  const files: Array<{ name: string; size: number; modified: string }> = [];
  for (const name of entries) {
    try {
      const s = await stat(join(filesDir, name));
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
  const token = extractToken(req.headers.authorization, req.headers['x-api-key'] as string | undefined);
  const { paths, userHash } = await setupCredentials(token);
  const filesDir = resolveFilesDir(req, paths);

  const fileName = params.name;
  // Prevent directory traversal
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    throw new NotFoundError('Invalid file name');
  }

  const filePath = join(filesDir, fileName);
  try {
    await unlink(filePath);
    log('info', 'File deleted', { userHash, fileName });
    sendJSON(res, 200, { deleted: true, name: fileName });
  } catch {
    throw new NotFoundError(`File "${fileName}" not found`);
  }
}

// ── MIME type map ────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.md': 'text/markdown',
};

export async function downloadFileHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const token = extractToken(req.headers.authorization, req.headers['x-api-key'] as string | undefined);
  const { paths } = await setupCredentials(token);
  const filesDir = resolveFilesDir(req, paths);

  const fileName = params.name;
  // Block path traversal
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    throw new NotFoundError('Invalid file name');
  }

  const filePath = join(filesDir, fileName);

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new NotFoundError(`File "${fileName}" not found`);
  }

  if (!fileStat.isFile()) {
    throw new NotFoundError(`File "${fileName}" not found`);
  }

  const ext = extname(fileName).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Content-Length': fileStat.size,
  });

  const stream = createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', () => {
    if (!res.writableEnded) res.end();
  });
}
