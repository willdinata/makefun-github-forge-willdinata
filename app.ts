import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './lib/gitproto.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleRest } from './lib/rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestSequence = 0;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  requestSequence += 1;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `FORGE-${requestSequence.toString().padStart(8, '0')}`,
  });
  res.end(text);
}

async function validateJsonBody(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return undefined;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += data.length;
    if (length > 8 * 1024 * 1024) throw new Error('JSON body too large');
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://forge.local');
  } catch {
    return null;
  }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = parseUrl(req);
      if (url && req.method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const authorization = req.headers.authorization;
      if (!expectedToken || authorization !== `Bearer ${expectedToken}`) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }

      let jsonBody: unknown;
      if (/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
        try {
          jsonBody = await validateJsonBody(req);
        } catch {
          if (url?.pathname === '/mcp') {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          sendJson(res, 400, { message: 'Malformed JSON body' });
          return;
        }
      }

      if (url && req.method === 'POST' && url.pathname === '/api/graphql' && handleGraphql(res, jsonBody, sendJson)) return;
      if (url && req.method === 'POST' && url.pathname === '/mcp' && handleMcp(res, jsonBody, sendJson)) return;
      if (url && await handleRest(req, res, url, jsonBody)) return;
      if (url && await handleGit(req, res, url)) return;
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(res, 400, { message: error instanceof Error ? error.message : 'Malformed request' });
    });
  });
}
