import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/env.js';

describe('readEnv', () => {
  it('ignores the old GASX_ names', () => {
    expect(readEnv('API_PORT', { GASX_API_PORT: 'old' })).toBeUndefined();
  });

  it('works with SILICA_ alone and returns undefined when neither is set', () => {
    expect(readEnv('API_PORT', { SILICA_API_PORT: '4000' })).toBe('4000');
    expect(readEnv('API_PORT', {})).toBeUndefined();
  });
});