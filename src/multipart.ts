import { IncomingMessage } from 'node:http';
import Busboy from 'busboy';
import { BadRequestError } from './errors.js';

export interface ParsedFile {
  fieldName: string;
  fileName: string;
  contentType: string;
  data: Buffer;
}

/**
 * Parse multipart/form-data using busboy (battle-tested, used by Express/Fastify).
 * Collects file data into memory (within size limits).
 */
export function parseMultipart(req: IncomingMessage, maxBytes: number): Promise<ParsedFile[]> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'];
    if (!contentType) {
      reject(new BadRequestError('Missing Content-Type header'));
      return;
    }

    let busboy: ReturnType<typeof Busboy>;
    try {
      busboy = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 20 } });
    } catch {
      reject(new BadRequestError('Invalid multipart request'));
      return;
    }

    const files: ParsedFile[] = [];
    let rejected = false;

    busboy.on('file', (fieldName: string, stream: NodeJS.ReadableStream, info: { filename: string; encoding: string; mimeType: string }) => {
      const chunks: Buffer[] = [];
      let size = 0;

      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          if (!rejected) {
            rejected = true;
            reject(new BadRequestError(`File exceeds ${maxBytes} bytes`));
          }
          stream.resume(); // drain
          return;
        }
        chunks.push(chunk);
      });

      stream.on('end', () => {
        if (rejected) return;
        const fileName = sanitizeFileName(info.filename || 'upload');
        files.push({
          fieldName,
          fileName,
          contentType: info.mimeType || 'application/octet-stream',
          data: Buffer.concat(chunks),
        });
      });
    });

    busboy.on('finish', () => {
      if (!rejected) resolve(files);
    });

    busboy.on('error', (err: Error) => {
      if (!rejected) {
        rejected = true;
        reject(new BadRequestError(`Upload parse error: ${err.message}`));
      }
    });

    req.pipe(busboy);
  });
}

/** Remove path components and dangerous chars from filename. */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/^.*[\\/]/, '')              // Remove path components
    .replace(/[<>:"|?*\x00-\x1f]/g, '_') // Remove unsafe chars
    .replace(/^\.+/, '_')                 // No leading dots (hidden files)
    .slice(0, 255);                       // Limit length
}
