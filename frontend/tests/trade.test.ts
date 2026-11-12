import { describe, expect, it } from 'vitest';
import {
  batchPrepared,
  defaultLimitPrice,
  depositNeeded,
  errorLine,
  findNewFill,
  formatContracts,
  guidedState,
  isClaimable,
  isOnTick,
  marginBaseUnits,
  parseContracts,
  perPoint,
  referencePrice,
  snapToTick,
  stepSize,
  toOnChainQuantity,
  tradePnl,
  tradeSide,
} from '../src/lib/trade';

const TOKEN = 1_000_000n;

describe('ticket maths', () => {
  it('snaps prices to the tick, never below one tick', () => {
    expect(snapToTick(1012.4, 1)).toBe(1012);
    expect(snapToTick(1016, 10)).toBe(1020);
    expect(snapToTick(2, 10)).toBe(10);
    expect(snapToTick(Number.NaN, 5)).toBe(5);
  });

  it('converts contracts to on-chain quantity', () => {
    expect(toOnChainQuantity(1)).toBe(100);
    expect(toOnChainQuantity(0.01)).toBe(1);
    expect(toOnChainQuantity(2.5)).toBe(250);
    expect(toOnChainQuantity(0)).toBe(1);
  });

  it('moves 1 tUSDC per point per contract at the live multiplier', () => {
    expect(perPoint(10_000)).toBe(1);
  });

  it('computes margin as the contract does', () => {
    // 1000 x 100 x 10000 x 10% = 100 tUSDC
    expect(marginBaseUnits(1000, 1, 10_000, 0.1)).toBe(100n * TOKEN);
    expect(marginBaseUnits(1000, 0.5, 10_000, 0.1)).toBe(50n * TOKEN);
    expect(marginBaseUnits(Number.NaN, 1, 10_000, 0.1)).toBe(0n);
  });

  it('rounds a deposit shortfall up to a whole token', () => {
    expect(depositNeeded(100n * TOKEN, 0n)).toBe(100n * TOKEN);
    expect(depositNeeded(100n * TOKEN + 1n, 0n)).toBe(101n * TOKEN);
    expect(depositNeeded(10n, 20n)).toBe(0n);
  });

  it('parses typed sizes', () => {
    expect(parseContracts('1')).toBe(1);
    expect(parseContracts('0.01')).toBe(0.01);
    expect(parseContracts('2.5')).toBe(2.5);
    expect(parseContracts('.5')).toBe(0.5);
    expect(parseContracts('0')).toBeNull();
    expect(parseContracts('0.001')).toBeNull();
    expect(parseContracts('abc')).toBeNull();
    expect(parseContracts('')).toBeNull();
    expect(formatContracts(2.5)).toBe('2.5');
  });

  it('steps in whole contracts, never below one', () => {
    expect(stepSize(1, 1)).toBe(2);
    expect(stepSize(1, -1)).toBe(1);
    expect(stepSize(2.5, 1)).toBe(3);
    expect(stepSize(2.5, -1)).toBe(2);
  });

  it('checks prices against the tick', () => {
    expect(isOnTick(1010, 10)).toBe(true);
    expect(isOnTick(1015, 10)).toBe(false);
    expect(isOnTick(0, 1)).toBe(false);
  });

  it('prefers the oracle price, then the index level', () => {
    expect(referencePrice({ oracleHasPrice: true, oraclePrice: 1005, indexLevel: 1001.2 })).toBe(1005);
    expect(referencePrice({ oracleHasPrice: false, oraclePrice: 1005, indexLevel: 1001.2 })).toBe(1001.2);
    expect(referencePrice({ oracleHasPrice: false, oraclePrice: Number.NaN, indexLevel: null })).toBeNull();
  });

  it('defaults the limit to a nearby opposite quote, else the snapped price', () => {
    expect(defaultLimitPrice('long', 1000.4, 1, { bestAsk: 1001, bestBid: 999 })).toBe(1001);
    expect(defaultLimitPrice('short', 1000.4, 1, { bestAsk: 1001, bestBid: 999 })).toBe(999);
    expect(defaultLimitPrice('long', 1000.4, 1, {})).toBe(1000);
    // Far away quotes are ignored.
    expect(defaultLimitPrice('long', 1000, 1, { bestAsk: 1500 })).toBe(1000);
  });

  it('computes P&L for each side', () => {
    expect(tradePnl('long', 1000, 100, 1010, 10_000)).toBe(10);
    expect(tradePnl('short', 1000, 100, 1010, 10_000)).toBe(-10);
    expect(tradeSide({ buyer: 'a.testnet' }, 'a.testnet')).toBe('long');
    expect(tradeSide({ buyer: 'b.testnet' }, 'a.testnet')).toBe('short');
  });
});

describe('guided state', () => {
  const base = { connected: true, wallet: 0n, available: 0n, locked: 0n, margin: 100n * TOKEN };

  it('asks to connect first', () => {
    expect(guidedState({ ...base, connected: false }).step).toBe('connect');
  });

  it('offers the faucet with nothing anywhere', () => {
    expect(guidedState(base).step).toBe('fund');
  });

  it('offers the exact deposit when the wallet covers it', () => {
    const state = guidedState({ ...base, wallet: 1000n * TOKEN, available: 30n * TOKEN });
    expect(state).toEqual({ step: 'deposit', deposit: 70n * TOKEN });
  });

  it('falls back to the faucet when the wallet cannot cover the deposit', () => {
    expect(guidedState({ ...base, wallet: 10n * TOKEN }).step).toBe('fund');
  });

  it('trades with enough margin', () => {
    expect(guidedState({ ...base, available: 100n * TOKEN }).step).toBe('trade');
  });
});

describe('claims and fills', () => {
  const trade = {
    tradeId: 1,
    marketId: 3,
    buyer: 'me.testnet',
    buyerClaimed: false,
    sellerClaimed: false,
  };

  it('is claimable once its market is past', () => {
    expect(isClaimable(trade, 'me.testnet', 4, false)).toBe(true);
    expect(isClaimable(trade, 'me.testnet', 3, false)).toBe(false);
    expect(isClaimable(trade, 'me.testnet', 3, true)).toBe(true);
    expect(isClaimable(trade, 'me.testnet', null, false)).toBe(false);
  });

  it('is not claimable twice', () => {
    expect(isClaimable({ ...trade, buyerClaimed: true }, 'me.testnet', 4, false)).toBe(false);
    // The seller's flag is the one that counts for the seller.
    expect(isClaimable({ ...trade, buyerClaimed: true }, 'other.testnet', 4, false)).toBe(true);
  });

  it('finds the first new trade in the market', () => {
    const trades = [
      { tradeId: 1, marketId: 3, price: 990 },
      { tradeId: 2, marketId: 2, price: 1000 },
      { tradeId: 3, marketId: 3, price: 1001 },
    ];
    expect(findNewFill(trades, new Set([1]), 3)?.tradeId).toBe(3);
    expect(findNewFill(trades, new Set([1, 3]), 3)).toBeNull();
  });

  it('batches claims into one transaction under the gas limit', () => {
    const call = (id: number) => ({
      receiverId: 'market.testnet',
      actions: [
        {
          type: 'FunctionCall' as const,
          params: { methodName: 'claim', args: { id }, gas: '100000000000000', deposit: '0' },
        },
      ],
      summary: {},
    });
    const out = batchPrepared([call(1), call(2), call(3), call(4)]);
    expect(out).toHaveLength(2);
    expect(out[0]?.actions).toHaveLength(3);
    expect(out[1]?.actions).toHaveLength(1);
  });

  it('never surfaces configuration names in errors', () => {
    expect(errorLine(new Error('missing NEAR_ORACLE_KEY'), 'fallback')).toBe('fallback');
    expect(errorLine(new Error('price must be a multiple of 10'))).toBe('price must be a multiple of 10');
  });
});
