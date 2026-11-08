/**
 * Fetches all five CCI components live and prints a JSON snapshot, used to
 * set BASE_VALUES in src/compute/base.ts. Run: npx tsx scripts/snapshotCompute.ts
 * Optional env: GASX_API_AI_SERVICE_URL (default http://localhost:8000).
 */
import { GPU_BASKET, MODEL_BASKET } from '../src/compute/basket.js';
import { egsiScoreFromUrl, fetchAllComponents } from '../src/compute/fetchers.js';

const aiBase = process.env.GASX_API_AI_SERVICE_URL || 'http://localhost:8000';
const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => fetch(input, init);

const readings = await fetchAllComponents({ fetchImpl, getEgsiScore: egsiScoreFromUrl(aiBase, fetchImpl) });

const values: Record<string, number | null> = {};
for (const r of readings) values[r.id] = r.value === null ? null : Number(r.value.toPrecision(6));

console.log(
  JSON.stringify(
    {
      takenAt: new Date().toISOString(),
      values,
      gpuNames: GPU_BASKET.map((g) => g.name),
      modelIds: MODEL_BASKET,
      readings,
    },
    null,
    2,
  ),
);
