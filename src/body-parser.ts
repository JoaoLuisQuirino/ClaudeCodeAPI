import { IncomingMessage } from 'node:http';
import { BadRequestError } from './errors.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Read and parse JSON body from an incoming request.
 * - Enforces size limit (10 MB default)
 * - Returns typed result
 * - Throws BadRequestError on empty body, invalid JSON, or oversize
 */
export function parseJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        req.removeListener('data', onData);
        req.resume(); // drain remaining data
        reject(new BadRequestError(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
      } else {
        chunks.push(chunk);
      }
    };

    req.on('data', onData);

    req.on('end', () => {
      if (aborted) return;
      if (size === 0) {
        reject(new BadRequestError('Empty request body'));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(raw) as T);
      } catch {
        reject(new BadRequestError('Invalid JSON in request body'));
      }
    });

    req.on('error', (err) => {
      if (!aborted) reject(new BadRequestError(`Request read error: ${err.message}`));
    });
  });
}
