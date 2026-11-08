import type { ComponentId } from './types.js';

/** Fixed base date at which the index is defined as 1000. */
export const BASE_DATE = '2026-11-08';

/**
 * Base values (index = 1000 when every component equals its base), taken from
 * a live snapshot on 2026-11-08T13:03Z (scripts/snapshotCompute.ts). These are
 * part of methodology v1.0: change them only with a new methodology version.
 */
export const BASE_VALUES: Record<ComponentId, number> = {
  gpu_marketplace: 1.6554177615993964,
  cloud_gpu_spot: 1.42784,
  ai_inference: 0.682301,
  btc_hashprice: 0.0361876,
  blockspace: 134,
};
