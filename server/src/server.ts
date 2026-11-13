/**
 * Fastify app factory. Takes dependencies as plain constructor
 * arguments (GatewayDeps) rather than reaching for globals, so tests can
 * inject fakes implementing ChainAdapter and
 * exercise real route logic (including risk policy checks) via
 * Fastify's `.inject()` without a live network connection anywhere.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { ChainAdapter } from '@gasx/near-adapter';
import type { CciResponse } from './compute/service.js';
import type { HistorySources } from './compute/historySources.js';
import type { Database } from './db.js';
import type { EngineLayer } from './engineLayer.js';
import type { RiskPolicyConfig } from './riskPolicy.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerIndicesRoutes } from './routes/indices.js';
import { registerMarketRoutes } from './routes/market.js';
import { registerNewsRoutes } from './routes/news.js';
import { registerOrderRoutes } from './routes/orders.js';
import { registerTickRoute, type TickRouteDeps } from './tick-route.js';

export interface GatewayDeps {
  chainAdapter: ChainAdapter;
  /** Shared Compute Index service (cached, never throws in production).
   * One instance serves the indices route, the market route, chat and the tick. */
  getCci: () => Promise<CciResponse>;
  riskPolicy: RiskPolicyConfig;
  /** Optional off-chain depth/quote layer (the C++ engine). Null runs
   * the gateway exactly as before, without indicative depth. */
  engine?: EngineLayer | null;
  /** Undefined apiKey disables the chat assistant (POST /api/v1/chat
   * returns 501) rather than the route silently degrading. */
  groq?: { apiKey: string | undefined; model: string };
  /** Null when no database is configured; every call site treats
   * persistence as optional. */
  db?: Database | null;
  /** Cron tick wiring. Omitted, the tick route is not registered. */
  tick?: TickRouteDeps | null;
  /** Real database-free history (back-cast, on-chain settlements). Built on demand from the other deps when omitted. */
  historySources?: HistorySources | null;
  /** Defaults to true. Tests pass false to keep output clean. */
  logger?: boolean;
}

export function buildServer(deps: GatewayDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? true });

  app.get('/api/v1/health', async () => ({ status: 'ok' }));

  registerMarketRoutes(app, deps);
  registerIndicesRoutes(app, deps);
  registerOrderRoutes(app, deps);
  registerAccountRoutes(app, deps);
  registerChatRoutes(app, deps);
  registerNewsRoutes(app);
  if (deps.tick) registerTickRoute(app, deps.tick);

  // DevMarketUnavailableError (blockchain/near's
  // dev-market mode) maps to 503 with its message, because the caller
  // needs to know *why* orders are unavailable. Everything else falls
  // back to a generic 500 rather than leaking internal error details to
  // the caller; the real error is still logged server-side.
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    if (error instanceof Error && error.name === 'DevMarketUnavailableError') {
      return reply.status(503).send({ error: error.message });
    }
    return reply.status(500).send({ error: 'internal error' });
  });

  return app;
}

