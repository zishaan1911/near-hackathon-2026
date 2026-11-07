// Must be the first import in main.tsx. The NEAR wallet-selector and its
// @near-js dependencies were written for Node and reach for `Buffer` and
// `process` at module load; the browser has neither.
import { Buffer } from 'buffer';

interface NodeLikeGlobal {
  Buffer?: typeof Buffer;
  process?: { env: Record<string, string | undefined> };
}

const g = globalThis as unknown as NodeLikeGlobal;
if (!g.Buffer) g.Buffer = Buffer;
if (!g.process) g.process = { env: {} };
