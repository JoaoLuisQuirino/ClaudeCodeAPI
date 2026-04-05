import type { IncomingMessage, ServerResponse } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractToken, setupCredentials } from '../credentials.js';
import { BadRequestError } from '../errors.js';
import { parseMultipart } from '../multipart.js';
import { sendJSON } from '../sse.js';
import { config } from '../config.js';
import { log } from '../logger.js';

export async function uploadHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = extractToken(req.headers.authorization);
  const { paths, userHash } = await setupCredentials(token);

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    throw new BadRequestError('Content-Type must be multipart/form-data');
  }

  const files = await parseMultipart(req, config.maxFileSizeBytes);

  if (files.length === 0) {
    throw new BadRequestError('No files in upload');
  }

  const results: Array<{ name: string; size: number; path: string }> = [];

  for (const file of files) {
    const destPath = join(paths.files, file.fileName);
    await writeFile(destPath, file.data);
    results.push({
      name: file.fileName,
      size: file.data.length,
      path: `/files/${file.fileName}`,
    });
    log('info', 'File uploaded', { userHash, fileName: file.fileName, size: file.data.length });
  }

  sendJSON(res, 200, { uploaded: results });
}
