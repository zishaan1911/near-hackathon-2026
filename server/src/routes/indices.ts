/**
 * Silica Compute Index (SCI) routes:
 *   GET  /api/v1/indices/compute          current level + components + GPU view
 *   GET  /api/v1/indices/compute/history  persisted levels + real backfill
 *   GET|POST /api/v1/cron/compute-snapshot  records a snapshot (bearer CRON_SECRET)
 * Component failures are reported per component; the routes never throw on
 * upstream trouble.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createBackfillSource } from '../compute/history.js';
import { METHODOLOGY_VERSION } from '../compute/service.js';
import type { FetchImpl } from '../compute/types.js';
import type { GatewayDeps } from '../server.js';

export interface IndicesRouteOptions {
  fetchImpl?: FetchImpl;
  now?: () => number;
  /** Defaults to process.env; read per request (CRON_SECRET) and once (GASX_ETH_RPC_URL). */
  env?: NodeJS.ProcessEnv;
}

export const CURRENT_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';
export const HISTORY_CACHE_CONTROL = 'public, s-maxage=900, stale-while-revalidate=300';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function bearerMatches(request: FastifyRequest, secret: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  // Hash both sides so timingSafeEqual sees equal lengths.
  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(secret));
}

export function clampDays(raw: unknown): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(90, n));
}

export function registerIndicesRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  opts: IndicesRouteOptions = {},
): void {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const ethRpcUrl = env.GASX_ETH_RPC_URL || undefined;
  // The compute service is shared (built once in app.ts) so every consumer
  // hits the same cache.
  const getCci = deps.getCci;
  const getBackfill = createBackfillSource({
    fetchImpl,
    ...(opts.now ? { now: opts.now } : {}),
    ...(ethRpcUrl ? { rpcUrl: ethRpcUrl } : {}),
  });

  app.get('/api/v1/indices/compute', async (_request, reply) => {
    const body = await getCci();
    return reply.header('Cache-Control', CURRENT_CACHE_CONTROL).send(body);
  });

  app.get('/api/v1/indices/compute/history', async (request, reply) => {
    const days = clampDays((request.query as Record<string, unknown> | undefined)?.days);
    const db = deps.db ?? null;
    const [points, backfill] = await Promise.all([
      db ? db.getComputeIndexHistory(days) : Promise.resolve([]),
      getBackfill(days),
    ]);
    return reply
      .header('Cache-Control', HISTORY_CACHE_CONTROL)
      .send({ persisted: db !== null, points, backfill });
  });

  const cronHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const secret = (opts.env ?? process.env).CRON_SECRET;
    if (!secret) return reply.status(503).send({ error: 'cron snapshot is not configured' });
    if (!bearerMatches(request, secret)) return reply.status(401).send({ error: 'unauthorized' });

    const cci = await getCci();
    const level = cci.index.level;
    let recorded = false;
    if (deps.db && level !== null) {
      recorded = await deps.db.recordComputeIndexSnapshot({
        level,
        components: cci.components,
        methodologyVersion: METHODOLOGY_VERSION,
      });
    }
    return reply.status(200).send({ recorded, level });
  };

  app.post('/api/v1/cron/compute-snapshot', cronHandler);
  app.get('/api/v1/cron/compute-snapshot', cronHandler);
}

