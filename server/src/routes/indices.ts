/**
 * GET /api/v1/indices/compute -- the Congest Compute Index (CCI).
 * Component failures are reported per component; the route itself never
 * throws on upstream trouble.
 */
import type { FastifyInstance } from 'fastify';
import { createComputeService } from '../compute/service.js';
import type { FetchImpl } from '../compute/types.js';
import type { GatewayDeps } from '../server.js';

export interface IndicesRouteOptions {
  fetchImpl?: FetchImpl;
  now?: () => number;
}

export function registerIndicesRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  opts: IndicesRouteOptions = {},
): void {
  const getCci = createComputeService({
    fetchImpl: opts.fetchImpl ?? ((input, init) => fetch(input, init)),
    // The gateway already wraps the AI service's /egsi/current in aiClient
    // (null on failure), so reuse it instead of threading a second URL.
    getEgsiScore: async () => (await deps.aiClient.getCurrentEgsi())?.score ?? null,
    ...(opts.now ? { now: opts.now } : {}),
  });

  app.get('/api/v1/indices/compute', async () => getCci());
}
