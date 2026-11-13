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
} from '@silica/near-adapter';
import { readEnv } from './env.js';

const MIN_TICK_GAP_MS = 10_000;
const MIN_POKE_GAP_MS = 15_000;

export interface TickRouteDeps {
  /** NEAR adapter config (RPC URL, contract id, dev-market flag). */
  config: NearAdapterConfig;
  /** Current Compute Index level, or null when unavailable. */
  getPrice: () => Promise<number | null>;
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
  return createSigner(env);
}


/**
 * Demo liquidity (testnet only): when SILICA_DEMO_LIQUIDITY is 'true' the
 * publisher account also quotes a bid and an ask. The maker is the oracle
 * account, a conflict of interest that is acceptable only for a demo.
 */
export function liquidityContext(env: NodeJS.ProcessEnv): Partial<TickContext> {
  if (readEnv('DEMO_LIQUIDITY', env) !== 'true') return {};
  const accountId = readEnv('NEAR_PUBLISHER_ACCOUNT_ID', env);
  if (!accountId) return {};
  const qty = Number(readEnv('DEMO_LIQUIDITY_QUANTITY', env));
  const quantity = Number.isInteger(qty) && qty > 0 ? qty : 100;
  return {
    signerAccountId: accountId,
    liquidity: { quantity, offsetTicks: 1, maxRepriceDistance: 3 },
  };
}

export function registerTickRoute(app: FastifyInstance, deps: TickRouteDeps): void {
  const now = deps.now ?? Date.now;
  const run = deps.runTick ?? runTick;
  let lastFinishedAt: number | null = null;
  let inFlight = false;

  const sinceLast = (): number => (lastFinishedAt === null ? Infinity : now() - lastFinishedAt);
  const isConfigured = (env: NodeJS.ProcessEnv): boolean =>
    !deps.config.devMarket && !!deps.config.contractId && !!readEnv('NEAR_PUBLISHER_PRIVATE_KEY', env);

  /** Runs one tick under the shared in-flight guard. Throws on failure. */
  const execute = async (env: NodeJS.ProcessEnv): Promise<TickReport> => {
    inFlight = true;
    try {
      const signer = (deps.makeSigner ?? defaultSigner)(env);
      return await run({
        config: deps.config,
        contractId: deps.config.contractId,
        signer,
        getPrice: deps.getPrice,
        ...liquidityContext(env),
      });
    } finally {
      inFlight = false;
      lastFinishedAt = now();
    }
  };

  const cronHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const env = deps.env ?? process.env;
    const secret = env.CRON_SECRET;
    if (!secret) return reply.status(503).send({ error: 'cron tick is not configured' });
    if (!bearerMatches(request, secret)) return reply.status(401).send({ error: 'unauthorized' });

    if (inFlight || sinceLast() < MIN_TICK_GAP_MS) {
      return reply.status(429).send({ error: 'tick ran too recently' });
    }
    if (deps.config.devMarket || !deps.config.contractId) {
      return reply.status(503).send({ error: 'no contract configured (dev-market mode)' });
    }

    try {
      return reply.status(200).send(await execute(env));
    } catch (err) {
      // Message only: the signer never puts key material in its errors.
      request.log.error({ message: (err as Error).message }, 'tick failed');
      return reply.status(500).send({ error: 'tick failed' });
    }
  };

  // Public, unauthenticated: the frontend pokes it so the market keeps
  // moving between cron runs. Rate limited, and it never returns error
  // strings or internals (they are logged instead).
  const pokeHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const env = deps.env ?? process.env;
    if (!isConfigured(env)) return reply.status(200).send({ configured: false });
    if (inFlight || sinceLast() < MIN_POKE_GAP_MS) return reply.status(200).send({ skipped: true });

    try {
      const report = await execute(env);
      if (report.errors.length > 0) {
        request.log.warn({ errors: report.errors }, 'poke tick reported errors');
      }
      return reply.status(200).send({
        published: report.published,
        settled: report.settled,
        rolled: report.rolled,
        matched: report.matched.length,
        quoted: (report.quoted?.bids ?? 0) + (report.quoted?.asks ?? 0),
      });
    } catch (err) {
      request.log.error({ message: (err as Error).message }, 'poke tick failed');
      return reply.status(500).send({ failed: true });
    }
  };

  app.post('/api/v1/cron/tick', cronHandler);
  app.get('/api/v1/cron/tick', cronHandler);
  app.post('/api/v1/market/poke', pokeHandler);
}
