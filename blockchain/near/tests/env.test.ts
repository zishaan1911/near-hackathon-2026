import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/env.js';

describe('readEnv', () => {
  it('ignores the old GASX_ names', () => {
    expect(readEnv('NEAR_CONTRACT_ID', { GASX_NEAR_CONTRACT_ID: 'old' })).toBeUndefined();
  });

  it('works with SILICA_ alone and returns undefined when neither is set', () => {
    expect(readEnv('NEAR_NETWORK', { SILICA_NEAR_NETWORK: 'mainnet' })).toBe('mainnet');
    expect(readEnv('NEAR_NETWORK', {})).toBeUndefined();
  });
});
