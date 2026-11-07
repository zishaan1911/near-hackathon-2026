import { describe, expect, it } from 'vitest';
import { DevMarketUnavailableError, NearChainAdapter } from '../src/nearAdapter.js';
import { fetchDevMarketState } from '../src/devMarket.js';
import type { NearAdapterConfig } from '../src/config.js';

function devConfig(): NearAdapterConfig {
  return {
    network: 'testnet',
    rpcUrl: 'https://test.rpc.fastnear.com',
    contractId: '',
    collateralToken: '',
    devMarket: true,
  };
}

describe('dev market', () => {
  it('serves a synthetic market with sane EGSI-1H terms', () => {
    const state = fetchDevMarketState(devConfig());

    expect(state.devMode).toBe(true);
    expect(state.network).toBe('testnet');
    expect(state.paused).toBe(false);
    expect(state.settled).toBe(false);
    expect(state.contractMultiplier).toBeGreaterThan(0);
    expect(state.tickSize).toBeGreaterThan(0);
    expect(state.oracle.hasPrice).toBe(false);
    expect(state.oracle.maxPrice).toBe(1000);

    const now = Date.now();
    expect(state.expiryMs).toBeGreaterThan(now);
    expect(state.expiryMs - now).toBeLessThanOrEqual(3_600_000);
  });

  it('preparing any transaction throws DevMarketUnavailableError', () => {
    const adapter = new NearChainAdapter(devConfig());
    expect(() => adapter.preparePlaceOrder({ trader: 'a.testnet', isBid: true, price: 500, quantity: 5 })).toThrow(
      DevMarketUnavailableError,
    );
    expect(() => adapter.prepareCancelOrder({ trader: 'a.testnet', orderId: 1 })).toThrow(DevMarketUnavailableError);
    expect(() => adapter.prepareDeposit({ trader: 'a.testnet', amount: '100' })).toThrow(DevMarketUnavailableError);
    expect(() => adapter.prepareWithdraw({ trader: 'a.testnet', amount: '100' })).toThrow(DevMarketUnavailableError);
    expect(() => adapter.prepareClaim({ trader: 'a.testnet', tradeId: 1 })).toThrow(DevMarketUnavailableError);
  });

  it('serves empty reads and zero balances without touching the network', async () => {
    const adapter = new NearChainAdapter(devConfig());
    expect(await adapter.getAccount('a.testnet')).toEqual({ available: '0', locked: '0' });
    expect(await adapter.getOpenOrders()).toEqual([]);
    expect(await adapter.getOrdersByAccount('a.testnet')).toEqual([]);
    expect(await adapter.getTradesByAccount('a.testnet')).toEqual([]);
    expect((await adapter.getMarketState()).devMode).toBe(true);
  });
});
