import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

const MAX_BODY_BYTES = 64 * 1024;

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}
