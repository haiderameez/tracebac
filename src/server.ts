import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { runTurn, type Deps } from './pipeline.ts';
import { fixedClock } from './time.ts';

const Body = z.object({
  sessionId: z.string().min(1).max(80),
  userId: z.string().min(1).max(80),
  text: z.string().trim().min(1).max(4000),
  tz: z.string().max(80).optional(),
  now: z.number().optional(),
});

const PAGE = new URL('../public/index.html', import.meta.url);
const MAX_BODY = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function createApp(deps: Deps & { allowClockOverride: boolean }): Server {
  async function chat(req: IncomingMessage, res: ServerResponse) {
    let parsed: z.infer<typeof Body>;
    try {
      parsed = Body.parse(JSON.parse(await readBody(req)));
    } catch (e) {
      return json(res, 400, { error: e instanceof z.ZodError ? 'send {sessionId, userId, text, tz}' : String(e instanceof Error ? e.message : e) });
    }

    const abort = new AbortController();
    res.on('close', () => abort.abort());
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const turnDeps = deps.allowClockOverride && parsed.now !== undefined ? { ...deps, clock: fixedClock(parsed.now) } : deps;
    try {
      for await (const event of runTurn(turnDeps, { sessionId: parsed.sessionId, userId: parsed.userId, text: parsed.text, tz: parsed.tz ?? '', signal: abort.signal })) {
        if (res.writableEnded || res.destroyed) break;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (e) {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'delta', text: `Something broke on my side (${e instanceof Error ? e.message : 'unknown error'}).` })}\n\n`);
    }
    res.end();
  }

  return createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(await readFile(PAGE));
      }
      if (req.method === 'POST' && path === '/api/chat') return await chat(req, res);
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : 'server error' });
      else res.end();
    }
  });
}
