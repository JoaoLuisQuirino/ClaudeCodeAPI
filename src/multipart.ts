import { IncomingMessage } from 'node:http';
import { BadRequestError } from './errors.js';

export interface ParsedFile {
  fieldName: string;
  fileName: string;
  contentType: string;
  data: Buffer;
}

/**
 * Minimal multipart/form-data parser. Zero dependencies.
 * Parses the entire body into memory (fine for file uploads within size limits).
 */
export function parseMultipart(req: IncomingMessage, maxBytes: number): Promise<ParsedFile[]> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
    if (!boundaryMatch) {
      reject(new BadRequestError('Missing multipart boundary'));
      return;
    }
    const boundary = boundaryMatch[1] || boundaryMatch[2];

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        req.resume();
        reject(new BadRequestError(`Upload exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      try {
        const body = Buffer.concat(chunks);
        const files = extractParts(body, boundary);
        resolve(files);
      } catch (err) {
        reject(new BadRequestError(`Multipart parse error: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

    req.on('error', (err) => {
      if (!aborted) reject(new BadRequestError(`Upload read error: ${err.message}`));
    });
  });
}

function extractParts(body: Buffer, boundary: string): ParsedFile[] {
  const delim = Buffer.from(`--${boundary}`);
  const files: ParsedFile[] = [];

  let start = bufferIndexOf(body, delim, 0);
  if (start === -1) return files;

  while (true) {
    // Move past delimiter + CRLF
    start += delim.length;
    // Check for end marker (--)
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    // Skip CRLF after delimiter
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;

    // Find end of headers (double CRLF)
    const headerEnd = bufferIndexOf(body, Buffer.from('\r\n\r\n'), start);
    if (headerEnd === -1) break;

    const headerStr = body.slice(start, headerEnd).toString('utf-8');
    const dataStart = headerEnd + 4;

    // Find next boundary
    const nextBoundary = bufferIndexOf(body, delim, dataStart);
    if (nextBoundary === -1) break;

    // Data ends before CRLF before next boundary
    let dataEnd = nextBoundary - 2; // skip CRLF before boundary
    if (dataEnd < dataStart) dataEnd = dataStart;

    // Parse headers
    const headers = parsePartHeaders(headerStr);
    const disposition = headers['content-disposition'] || '';
    const fieldName = extractHeaderParam(disposition, 'name') || 'file';
    const fileName = extractHeaderParam(disposition, 'filename') || 'upload';
    const partContentType = headers['content-type'] || 'application/octet-stream';

    if (fileName) {
      files.push({
        fieldName,
        fileName: sanitizeFileName(fileName),
        contentType: partContentType,
        data: body.slice(dataStart, dataEnd),
      });
    }

    start = nextBoundary;
  }

  return files;
}

function bufferIndexOf(haystack: Buffer, needle: Buffer, offset: number): number {
  for (let i = offset; i <= haystack.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
}

function parsePartHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  return headers;
}

function extractHeaderParam(header: string, param: string): string | null {
  const regex = new RegExp(`${param}="([^"]*)"`, 'i');
  const match = header.match(regex);
  return match ? match[1] : null;
}

/** Remove path components and dangerous chars from filename. */
function sanitizeFileName(name: string): string {
  return name
    .replace(/^.*[\\/]/, '')        // Remove path
    .replace(/[<>:"|?*\x00-\x1f]/g, '_') // Remove unsafe chars
    .replace(/^\.+/, '_')           // No leading dots
    .slice(0, 255);                 // Limit length
}
