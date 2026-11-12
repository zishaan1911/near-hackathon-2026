/**
 * Shared composition root: builds the real GatewayDeps (config, database,
 * NEAR adapter, compute index service, engine layer) and the Fastify app. Used by the
 * local entrypoint (src/index.ts) and the Vercel function (api/index.ts).
 */
import type { FastifyInstance } from 'fastify';
import { NearChainAdapter } from '@gasx/near-adapter';
import { createComputeService } from './compute/service.js';
import { loadGatewayConfig } from './config.js';
import { createDatabase } from './db.js';
import { OnChainEngineLayer } from './engineLayer.js';
import { buildServer, type GatewayDeps } from './server.js';

export function createGatewayDeps(env: NodeJS.ProcessEnv = process.env): GatewayDeps {
  // The config loaders read process.env; mirror a custom env into it.
  if (env !== process.env) {
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) process.env[key] = value;
    }
  }

  const config = loadGatewayConfig();
  const db = createDatabase(config.databaseUrl, { error: (m) => console.error(m) });
  const chainAdapter = new NearChainAdapter(config.near);

  // One compute service for the whole process: the indices route, market
  // route, chat and the tick all share its cache.
  const ethRpcUrl = process.env.GASX_ETH_RPC_URL || undefined;
  const getCci = createComputeService({
    fetchImpl: (input, init) => fetch(input, init),
    ...(ethRpcUrl ? { ethRpcUrl } : {}),
  });

  return {
    db,
    engine: new OnChainEngineLayer(
      {
        contractMultiplier: 10,
        marginRatioBps: 1000,
        maxOrderQuantity: config.riskPolicy.maxOrderContracts,
        maxNetPosition: config.riskPolicy.maxPositionContracts,
      },
      chainAdapter,
    ),
    chainAdapter,
    getCci,
    riskPolicy: config.riskPolicy,
    groq: config.groq,
    tick: {
      config: config.near,
      getPrice: async () => (await getCci()).index.level,
    },
    logger: true,
  };
}

export function buildApp(env: NodeJS.ProcessEnv = process.env): FastifyInstance {
  return buildServer(createGatewayDeps(env));
}

