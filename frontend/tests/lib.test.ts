import { describe, expect, it } from 'vitest';
import { marketNumber, normaliseMarket } from '../src/lib/api';
import { formatSigned, formatTokenAmount, formatTusdc, groupThousands, parseTokenAmount } from '../src/lib/format';
import { formatCountdown, percentVsBase } from '../src/lib/market';
import { matchRoute, needsWallet } from '../src/lib/routes';
import { decodeBalance, faucetTransaction } from '../src/lib/token';

describe('router matching', () => {
  it('matches the four routes', () => {
    expect(matchRoute('/')).toBe('home');
    expect(matchRoute('')).toBe('home');
    expect(matchRoute('/index.html')).toBe('home');
    expect(matchRoute('/compute')).toBe('index');
    expect(matchRoute('/compute/')).toBe('index');
    expect(matchRoute('/Trade')).toBe('trade');
    expect(matchRoute('/portfolio?x=1')).toBe('portfolio');
    expect(matchRoute('/trade#book')).toBe('trade');
    expect(matchRoute('/nope')).toBe('notFound');
  });

  it('loads wallet code only for trade and portfolio', () => {
    expect(needsWallet('trade')).toBe(true);
    expect(needsWallet('portfolio')).toBe(true);
    expect(needsWallet('home')).toBe(false);
    expect(needsWallet('index')).toBe(false);
  });
});

describe('token amounts', () => {
  it('formats and parses 6-decimal amounts', () => {
    expect(formatTokenAmount('1500000')).toBe('1.50');
    expect(formatTokenAmount('x')).toBe('—');
    expect(parseTokenAmount('1.5')).toBe('1500000');
    expect(parseTokenAmount('0.0000001')).toBeNull();
    expect(parseTokenAmount('-1')).toBeNull();
    expect(formatTusdc('1000000000000', true)).toBe('1,000,000');
    expect(formatTusdc(1234500000n)).toBe('1,234.50');
    expect(groupThousands('1234567.5')).toBe('1,234,567.5');
    expect(formatSigned(3)).toBe('+3.00');
    expect(formatSigned(-3)).toBe('-3.00');
  });

  it('builds the faucet call', () => {
    const tx = faucetTransaction('tusdc.test');
    expect(tx.receiverId).toBe('tusdc.test');
    expect(tx.actions[0]?.params.methodName).toBe('faucet');
    expect(tx.actions[0]?.params.gas).toBe('30000000000000');
  });

  it('decodes a view-call balance', () => {
    const bytes = [...new TextEncoder().encode('"1000000000"')];
    expect(decodeBalance(bytes)).toBe('1000000000');
    expect(() => decodeBalance('nope')).toThrow();
  });
});

describe('market', () => {
  it('reads the market number from its id', () => {
    expect(marketNumber('gasx.testnet#4')).toBe(4);
    expect(marketNumber('SCI-1H')).toBeNull();
  });

  it('survives null fields', () => {
    const snap = normaliseMarket({ market: { marketId: 'gasx.testnet#2', underlying: 'SCI-1H' }, index: null, orderbook: null });
    expect(snap.market.number).toBe(2);
    expect(snap.market.label).toBe('SCI-1H');
    expect(snap.index).toBeNull();
    expect(snap.orderbook.asks).toEqual([]);
  });

  it('formats the countdown', () => {
    expect(formatCountdown(1_000 + 42 * 60_000 + 10_000, 1_000)).toBe('42:10');
    expect(formatCountdown(0, 1_000)).toBeNull();
    expect(percentVsBase(1010, 1000)).toBeCloseTo(1);
  });
});
