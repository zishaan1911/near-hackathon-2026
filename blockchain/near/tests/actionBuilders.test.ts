import { describe, expect, it } from 'vitest';
import {
  buildCancelOrder,
  buildClaim,
  buildDeposit,
  buildPlaceOrder,
  buildWithdraw,
} from '../src/actionBuilders.js';

const ids = { contractId: 'gasx.testnet', collateralToken: 'tusdc.testnet' };

describe('buildDeposit', () => {
  it('calls ft_transfer_call on the collateral token with 100 Tgas and 1 yocto', () => {
    const tx = buildDeposit(ids, { trader: 'alice.testnet', amount: '5000000' });
    expect(tx.receiverId).toBe('tusdc.testnet');
    expect(tx.actions).toEqual([
      {
        type: 'FunctionCall',
        params: {
          methodName: 'ft_transfer_call',
          args: { receiver_id: 'gasx.testnet', amount: '5000000', msg: '' },
          gas: '100000000000000',
          deposit: '1',
        },
      },
    ]);
    expect(tx.summary).toMatchObject({ action: 'deposit', trader: 'alice.testnet', amount: '5000000' });
  });
});

describe('buildWithdraw', () => {
  it('calls withdraw on the contract with 60 Tgas and 1 yocto', () => {
    const tx = buildWithdraw(ids, { trader: 'alice.testnet', amount: '123' });
    expect(tx.receiverId).toBe('gasx.testnet');
    expect(tx.actions).toEqual([
      {
        type: 'FunctionCall',
        params: { methodName: 'withdraw', args: { amount: '123' }, gas: '60000000000000', deposit: '1' },
      },
    ]);
  });
});

describe('buildPlaceOrder', () => {
  it('calls place_order with 30 Tgas and no deposit', () => {
    const tx = buildPlaceOrder(ids, { trader: 'alice.testnet', isBid: true, price: 500, quantity: 10 });
    expect(tx.receiverId).toBe('gasx.testnet');
    expect(tx.actions).toEqual([
      {
        type: 'FunctionCall',
        params: {
          methodName: 'place_order',
          args: { is_bid: true, price: 500, quantity: 10 },
          gas: '30000000000000',
          deposit: '0',
        },
      },
    ]);
    expect(tx.summary).toMatchObject({ action: 'place_order', side: 'bid', price: 500, quantity: 10 });
  });

  it('labels asks and rejects non-positive or fractional price/quantity', () => {
    expect(buildPlaceOrder(ids, { trader: 'a', isBid: false, price: 1, quantity: 1 }).summary.side).toBe('ask');
    expect(() => buildPlaceOrder(ids, { trader: 'a', isBid: true, price: 0, quantity: 1 })).toThrow(/price/);
    expect(() => buildPlaceOrder(ids, { trader: 'a', isBid: true, price: 1.5, quantity: 1 })).toThrow(/price/);
    expect(() => buildPlaceOrder(ids, { trader: 'a', isBid: true, price: 1, quantity: -1 })).toThrow(/quantity/);
  });
});

describe('buildCancelOrder', () => {
  it('calls cancel_order with 30 Tgas and no deposit', () => {
    const tx = buildCancelOrder(ids, { trader: 'alice.testnet', orderId: 7 });
    expect(tx.receiverId).toBe('gasx.testnet');
    expect(tx.actions).toEqual([
      {
        type: 'FunctionCall',
        params: { methodName: 'cancel_order', args: { order_id: 7 }, gas: '30000000000000', deposit: '0' },
      },
    ]);
  });

  it('rejects a negative or fractional order id', () => {
    expect(() => buildCancelOrder(ids, { trader: 'a', orderId: -1 })).toThrow(/orderId/);
    expect(() => buildCancelOrder(ids, { trader: 'a', orderId: 1.5 })).toThrow(/orderId/);
  });
});

describe('buildClaim', () => {
  it('calls claim with 30 Tgas and no deposit', () => {
    const tx = buildClaim(ids, { trader: 'alice.testnet', tradeId: 4 });
    expect(tx.receiverId).toBe('gasx.testnet');
    expect(tx.actions).toEqual([
      {
        type: 'FunctionCall',
        params: { methodName: 'claim', args: { trade_id: 4 }, gas: '30000000000000', deposit: '0' },
      },
    ]);
  });

  it('rejects an invalid trade id', () => {
    expect(() => buildClaim(ids, { trader: 'a', tradeId: Number.NaN })).toThrow(/tradeId/);
  });
});

describe('amount validation', () => {
  it.each(['0', '-5', '1.5', '', 'abc', '01', ' 5'])('rejects %j for deposit and withdraw', (amount) => {
    expect(() => buildDeposit(ids, { trader: 'a', amount })).toThrow(/amount/);
    expect(() => buildWithdraw(ids, { trader: 'a', amount })).toThrow(/amount/);
  });
});
