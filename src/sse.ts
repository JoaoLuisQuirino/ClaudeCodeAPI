import { ServerResponse } from 'node:http';

/** Write SSE headers + start keepalive pings. Call once before any sendSSE/endSSE. */
export function initSSE(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Keepalive: prevent proxies from killing idle connections during long thinking
  let pingCount = 0;
  const keepalive = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) {
      const ok = res.write(':ping\n\n');
      pingCount++;
      if (pingCount <= 3 || pingCount % 10 === 0) {
        console.log(`[sse] ping #${pingCount} sent, write ok: ${ok}`);
      }
    } else {
      console.log(`[sse] ping skipped — res destroyed: ${res.destroyed}, ended: ${res.writableEnded}`);
    }
  }, 15_000);

  // Clean up on close
  res.on('close', () => clearInterval(keepalive));
}

/** Write a single SSE event. Returns false if the response is already closed. */
export function sendSSE(res: ServerResponse, event: string, data: unknown): boolean {
  if (res.destroyed || res.writableEnded) return false;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return res.write(`event: ${event}\ndata: ${payload}\n\n`);
}

/** Gracefully end the SSE stream. */
export function endSSE(res: ServerResponse): void {
  if (!res.destroyed && !res.writableEnded) {
    res.end();
  }
}

/** Send a JSON response (non-streaming). */
export function sendJSON(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
