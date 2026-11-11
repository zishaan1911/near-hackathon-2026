export type ComponentId =
  | 'gpu_rental'
  | 'cloud_gpu_spot'
  | 'cloud_cpu_spot'
  | 'ai_inference'
  | 'btc_hashprice'
  | 'blockspace';

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export type ComponentDetail = Record<string, number | string>;

/**
 * One price from one venue for one product, with a stable key such as
 * `gpu/h100/vast`. Quotes are the unit the matched-quote method works on.
 */
export interface Quote {
  key: string;
  component: ComponentId;
  /** Grouping level between quote and component (e.g. `h100`). */
  product: string;
  /** Venue id, a key of VENUE_LABELS (e.g. `vast`). */
  venue: string;
  price: number;
}

/** A quote the index expects to see (whether or not the venue delivered it). */
export interface ExpectedQuote {
  key: string;
  product: string;
  venue: string;
}

/** What a fetcher returns for one component. Fetchers never throw. */
export interface ComponentFetch {
  id: ComponentId;
  quotes: Quote[];
  expected: ExpectedQuote[];
  /** Per-venue failures, informational. */
  errors: string[];
  detail?: ComponentDetail;
}

export interface ComponentMeta {
  id: ComponentId;
  label: string;
  unit: string;
  nominalWeight: number;
  source: string;
}

export const COMPONENT_META: readonly ComponentMeta[] = [
  { id: 'gpu_rental', label: 'GPU rental', unit: '$/GPU-hour', nominalWeight: 0.35, source: 'Vast.ai, RunPod, Akash' },
  { id: 'cloud_gpu_spot', label: 'Cloud GPU spot', unit: '$/GPU-hour', nominalWeight: 0.2, source: 'AWS and Azure spot' },
  { id: 'cloud_cpu_spot', label: 'Cloud CPU spot', unit: '$/vCPU-hour', nominalWeight: 0.1, source: 'AWS and Azure spot' },
  { id: 'ai_inference', label: 'AI inference', unit: '$/1M tokens (blended)', nominalWeight: 0.2, source: 'OpenRouter model list' },
  { id: 'btc_hashprice', label: 'Bitcoin hashprice', unit: '$/TH/day', nominalWeight: 0.1, source: 'blockchain.info + CoinGecko' },
  { id: 'blockspace', label: 'Ethereum blockspace', unit: '$/1M gas (7-day median)', nominalWeight: 0.05, source: 'Ethereum JSON-RPC base fees + ETH/USD' },
];

export const COMPONENT_IDS: readonly ComponentId[] = COMPONENT_META.map((m) => m.id);

export function metaFor(id: ComponentId): ComponentMeta {
  const m = COMPONENT_META.find((c) => c.id === id);
  if (!m) throw new Error(`unknown component ${id}`);
  return m;
}

export const VENUE_LABELS: Readonly<Record<string, string>> = {
  vast: 'Vast.ai',
  runpod: 'RunPod',
  akash: 'Akash',
  azure: 'Azure',
  aws: 'AWS',
  openrouter: 'OpenRouter',
  blockchain: 'blockchain.info',
  ethrpc: 'Ethereum RPC',
};

export function venueLabel(venue: string): string {
  return VENUE_LABELS[venue] ?? venue;
}
