/**
 * Vercel serverless entry for the Fastify gateway. The app is built once
 * per cold start; each invocation hands the raw Node request/response to
 * Fastify's underlying http server. vercel.json rewrites /api/v1/* here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/src/app.js';

export const config = { maxDuration: 60 };

let appPromise: Promise<FastifyInstance> | undefined;

function getApp(): Promise<FastifyInstance> {
  appPromise ??= (async () => {
    const app = buildApp();
    await app.ready();
    return app;
  })();
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getApp();
  app.server.emit('request', req, res);
}
