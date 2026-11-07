/**
 * Cron tick endpoint. Supabase pg_cron + pg_net call it every minute (see
 * supabase/migrations/0002_cron.sql); it publishes the oracle price,
 * settles/rolls the market and matches orders via the adapter's runTick,
 * all signed by the single publisher account.
 *
 * Auth is a shared bearer secret (CRON_SECRET). With no secret configured
 * the route refuses every request: it is never open.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createSigner,
  runTick,
  type NearAdapterConfig,
  type TickContext,
  type TickReport,
} from '@gasx/near-adapter';

const MIN_TICK_GAP_MS = 10_000;

export interface TickRouteDeps {
  /** NEAR adapter config (RPC URL, contract id, dev-market flag). */
  config: NearAdapterConfig;
  /** Base URL of the AI service. */
  aiUrl: string;
  /** Defaults to process.env; read per request. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Override for tests; defaults to the adapter's runTick. */
  runTick?: (ctx: TickContext) => Promise<TickReport>;
  /** Override for tests; defaults to the publisher account from env. */
  makeSigner?: (env: NodeJS.ProcessEnv) => TickContext['signer'];
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function bearerMatches(request: FastifyRequest, secret: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  // Hash both sides so timingSafeEqual sees equal lengths and the secret's
  // length does not leak.
  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(secret));
}

function defaultSigner(env: NodeJS.ProcessEnv): TickContext['signer'] {
  // createSigner reads process.env; copy the two keys across when a custom
  // env was supplied.
  for (const name of ['GASX_NEAR_PUBLISHER_ACCOUNT_ID', 'GASX_NEAR_PUBLISHER_PRIVATE_KEY']) {
    const value = env[name];
    if (value !== undefined) process.env[name] = value;
  }
  return createSigner('GASX_NEAR_PUBLISHER_ACCOUNT_ID', 'GASX_NEAR_PUBLISHER_PRIVATE_KEY');
}

export function registerTickRoute(app: FastifyInstance, deps: TickRouteDeps): void {
  const now = deps.now ?? Date.now;
  const run = deps.runTick ?? runTick;
  let lastFinishedAt: number | null = null;
  let inFlight = false;

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const env = deps.env ?? process.env;
    const secret = env.CRON_SECRET;
    if (!secret) return reply.status(503).send({ error: 'cron tick is not configured' });
    if (!bearerMatches(request, secret)) return reply.status(401).send({ error: 'unauthorized' });

    if (inFlight || (lastFinishedAt !== null && now() - lastFinishedAt < MIN_TICK_GAP_MS)) {
      return reply.status(429).send({ error: 'tick ran too recently' });
    }
    if (deps.config.devMarket || !deps.config.contractId) {
      return reply.status(503).send({ error: 'no contract configured (dev-market mode)' });
    }

    inFlight = true;
    try {
      const signer = (deps.makeSigner ?? defaultSigner)(env);
      const report = await run({
        config: deps.config,
        contractId: deps.config.contractId,
        signer,
        aiUrl: deps.aiUrl,
      });
      return reply.status(200).send(report);
    } catch (err) {
      // Message only: the signer never puts key material in its errors.
      request.log.error({ message: (err as Error).message }, 'tick failed');
      return reply.status(500).send({ error: 'tick failed' });
    } finally {
      inFlight = false;
      lastFinishedAt = now();
    }
  };

  app.post('/api/v1/cron/tick', handler);
  app.get('/api/v1/cron/tick', handler);
}
