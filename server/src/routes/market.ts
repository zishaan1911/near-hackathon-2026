/**
 * Market routes for the hourly Congest Compute Index (CCI) future:
 *   GET /api/v1/market   on-chain market state + live CCI level, pillars,
 *                        on-chain depth and an indicative quote
 *   GET /api/v1/candles  OHLC buckets of the persisted CCI levels
 */
import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../server.js';

const MARKET_ID = 'CCI-1H';

export function registerMarketRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  /** CCI level as OHLC candles for the chart. */
  app.get<{ Querystring: { interval?: string; limit?: string } }>(
    '/api/v1/candles',
    async (request, reply) => {
      if (!deps.db) {
        return reply.status(503).send({ error: 'no database configured; see database/README.md' });
      }
      const interval = Number.parseInt(request.query.interval ?? '300', 10);
      const limit = Number.parseInt(request.query.limit ?? '200', 10);
      const candles = await deps.db.getComputeIndexCandles(
        Number.isFinite(interval) ? interval : 300,
        Number.isFinite(limit) ? limit : 200,
      );
      return { market: MARKET_ID, interval, count: candles.length, candles };
    },
  );

  app.get('/api/v1/market', async (request) => {
    // Chain read failures propagate (caught by the server's default error
    // handler): market state is this endpoint's core purpose. The index,
    // pillars, depth and quote degrade instead.
    const market = await deps.chainAdapter.getMarketState();

    let index: {
      level: number | null;
      base: number;
      baseDate: string;
      asOf: string;
      degraded: boolean;
    } | null = null;
    let pillars: Array<{
      id: string;
      label: string;
      level: number | null;
      effectiveWeight: number;
      status: 'ok' | 'down';
    }> = [];
    try {
      const cci = await deps.getCci();
      index = {
        level: cci.index.level,
        base: cci.index.base,
        baseDate: cci.index.baseDate,
        asOf: cci.index.asOf,
        degraded: cci.index.degraded,
      };
      pillars = cci.components.map((c) => ({
        id: c.id,
        label: c.label,
        level: c.level,
        effectiveWeight: c.effectiveWeight,
        status: c.status,
      }));
    } catch (err) {
      request.log.warn({ message: (err as Error).message }, 'compute index unavailable');
    }

    // Depth is real: aggregated from on-chain open orders (authoritative,
    // `source: 'chain'`). The quote stays labelled indicative.
    let orderbook = null;
    let quote = null;
    if (deps.engine) {
      quote = deps.engine.quoteFromIndex(index?.level ?? null);
      orderbook = { ...(await deps.engine.getBook()), indicative: true as const };
    }

    return { market, index, pillars, orderbook, quote };
  });
}
