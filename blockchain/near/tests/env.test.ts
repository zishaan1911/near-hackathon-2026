import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/env.js';

describe('readEnv', () => {
  it('prefers SILICA_ over GASX_', () => {
    expect(readEnv('NEAR_CONTRACT_ID', { SILICA_NEAR_CONTRACT_ID: 'new', GASX_NEAR_CONTRACT_ID: 'old' })).toBe('new');
  });

  it('falls back to GASX_ when SILICA_ is unset', () => {
    expect(readEnv('NEAR_CONTRACT_ID', { GASX_NEAR_CONTRACT_ID: 'old' })).toBe('old');
  });

  it('works with SILICA_ alone and returns undefined when neither is set', () => {
    expect(readEnv('NEAR_NETWORK', { SILICA_NEAR_NETWORK: 'mainnet' })).toBe('mainnet');
    expect(readEnv('NEAR_NETWORK', {})).toBeUndefined();
  });
});
