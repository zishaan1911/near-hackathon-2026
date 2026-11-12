import { describe, expect, it } from 'vitest';
import type { PreparedTransaction } from '../src/lib/api';
import { buildDemoPlan, demoDepositAmount, needsDemo } from '../src/lib/demo';

const empty = { available: '0', locked: '0', openOrders: [], trades: [] };
const call = (receiverId: string, methodName: string): PreparedTransaction => ({
  receiverId,
  actions: [{ type: 'FunctionCall', params: { methodName, args: {}, gas: '1', deposit: '0' } }],
  summary: {},
});

describe('needsDemo', () => {
  it('shows for a connected, empty account', () => {
    expect(needsDemo(empty, { connected: true })).toBe(true);
  });
  it('hides when disconnected or account unknown', () => {
    expect(needsDemo(empty, { connected: false })).toBe(false);
    expect(needsDemo(null, { connected: true })).toBe(false);
  });
  it('hides with a deposit, locked funds, orders or trades', () => {
    expect(needsDemo({ ...empty, available: '1' }, { connected: true })).toBe(false);
    expect(needsDemo({ ...empty, locked: '1' }, { connected: true })).toBe(false);
    expect(needsDemo({ ...empty, openOrders: [{}] as never }, { connected: true })).toBe(false);
    expect(needsDemo({ ...empty, trades: [{}] as never }, { connected: true })).toBe(false);
  });
});

describe('demoDepositAmount', () => {
  it('adds 5% and rounds up to a whole tUSDC', () => {
    // 1000 * 100 * 10 * 10% = 100,000 base units; +5% = 105,000 -> 1 tUSDC
    expect(demoDepositAmount(1000, { contractMultiplier: 10, marginRate: 0.1 })).toBe('1000000');
    // 1000 * 100 * 1000 * 10% = 10,000,000; +5% = 10,500,000 -> 11 tUSDC
    expect(demoDepositAmount(1000, { contractMultiplier: 1000, marginRate: 0.1 })).toBe('11000000');
  });
  it('is zero when the market is not configured', () => {
    expect(demoDepositAmount(1000, {})).toBe('0');
  });
});

describe('buildDemoPlan', () => {
  const deposit = call('tusdc', 'ft_transfer_call');
  const order = call('market', 'place_order');
  const faucet = call('tusdc', 'faucet');

  it('merges faucet and deposit into one transaction', () => {
    const plan = buildDemoPlan({ needsFaucet: true, faucetTx: faucet, depositTx: deposit, orderTx: order });
    expect(plan).toHaveLength(2);
    expect(plan[0]?.actions.map((a) => a.params.methodName)).toEqual(['faucet', 'ft_transfer_call']);
    expect(plan[1]).toBe(order);
  });
  it('skips the faucet when not needed', () => {
    const plan = buildDemoPlan({ needsFaucet: false, faucetTx: faucet, depositTx: deposit, orderTx: order });
    expect(plan).toEqual([deposit, order]);
  });
  it('keeps them apart when the receivers differ', () => {
    const other = call('other', 'faucet');
    const plan = buildDemoPlan({ needsFaucet: true, faucetTx: other, depositTx: deposit, orderTx: order });
    expect(plan).toEqual([other, deposit, order]);
  });
});
