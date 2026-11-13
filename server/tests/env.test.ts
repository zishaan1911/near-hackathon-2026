import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/env.js';

describe('readEnv', () => {
  it('prefers SILICA_ over GASX_', () => {
    expect(readEnv('API_PORT', { SILICA_API_PORT: '4000', GASX_API_PORT: '3000' })).toBe('4000');
  });

  it('falls back to GASX_ when SILICA_ is unset', () => {
    expect(readEnv('API_PORT', { GASX_API_PORT: '3000' })).toBe('3000');
  });

  it('works with SILICA_ alone and returns undefined when neither is set', () => {
    expect(readEnv('API_PORT', { SILICA_API_PORT: '4000' })).toBe('4000');
    expect(readEnv('API_PORT', {})).toBeUndefined();
  });
});