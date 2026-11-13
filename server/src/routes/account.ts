/**
 * Account routes: prepares (never signs) the collateral transactions a
 * trader needs around trading — deposit, withdraw, claim — and reads the
 * trader's balance, orders and trades from the Silica contract. There is
 * no open-account step on NEAR: a deposit credits the contract's
 * `available` balance directly (docs/near-abi.md).
 */
import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../server.js';

interface PrepareAmountBody {
  trader?: unknown;
  amount?: unknown;
}

interface PrepareClaimBody {
  trader?: unknown;
  tradeId?: unknown;
}

interface ValidatedAmount {
  trader: string;
  amount: string;
}

function validateAmountBody(body: PrepareAmountBody): ValidatedAmount | string {
  if (typeof body.trader !== 'string' || !body.trader) return 'trader is required';
  if (typeof body.amount !== 'string' || !/^[1-9]\d*$/.test(body.amount)) {
    return 'amount must be a positive integer string in token base units';
  }
  return { trader: body.trader, amount: body.amount };
}

export function registerAccountRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  app.post<{ Body: PrepareAmountBody }>('/api/v1/account/prepare-deposit', async (request, reply) => {
    const validated = validateAmountBody(request.body ?? {});
    if (typeof validated === 'string') {
      return reply.status(400).send({ error: validated });
    }
    return deps.chainAdapter.prepareDeposit(validated);
  });

  app.post<{ Body: PrepareAmountBody }>('/api/v1/account/prepare-withdraw', async (request, reply) => {
    const validated = validateAmountBody(request.body ?? {});
    if (typeof validated === 'string') {
      return reply.status(400).send({ error: validated });
    }
    return deps.chainAdapter.prepareWithdraw(validated);
  });

  app.post<{ Body: PrepareClaimBody }>('/api/v1/trades/prepare-claim', async (request, reply) => {
    const { trader, tradeId } = request.body ?? {};
    if (typeof trader !== 'string' || !trader) {
      return reply.status(400).send({ error: 'trader is required' });
    }
    if (typeof tradeId !== 'number' || !Number.isSafeInteger(tradeId) || tradeId < 0) {
      return reply.status(400).send({ error: 'tradeId must be a non-negative integer' });
    }
    return deps.chainAdapter.prepareClaim({ trader, tradeId });
  });

  app.get<{ Params: { accountId: string } }>('/api/v1/account/:accountId', async (request) => {
    const { accountId } = request.params;
    const [balance, openOrders, orders, trades] = await Promise.all([
      deps.chainAdapter.getAccount(accountId),
      deps.chainAdapter.getOpenOrders(),
      deps.chainAdapter.getOrdersByAccount(accountId),
      deps.chainAdapter.getTradesByAccount(accountId),
    ]);
    return {
      accountId,
      available: balance.available,
      locked: balance.locked,
      openOrders,
      orders,
      trades,
    };
  });
}
