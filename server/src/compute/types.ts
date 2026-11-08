export type ComponentId =
  | 'gpu_marketplace'
  | 'cloud_gpu_spot'
  | 'ai_inference'
  | 'btc_hashprice'
  | 'blockspace';

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export type ComponentDetail = Record<string, number | string>;

export interface ComponentReading {
  id: ComponentId;
  label: string;
  unit: string;
  value: number | null;
  status: 'ok' | 'down';
  error?: string;
  source: string;
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
  { id: 'gpu_marketplace', label: 'GPU marketplace rental', unit: '$/GPU-hour', nominalWeight: 0.3, source: 'Vast.ai public offers' },
  { id: 'cloud_gpu_spot', label: 'Cloud GPU spot', unit: '$/GPU-hour', nominalWeight: 0.2, source: 'Azure Retail Prices API (Spot)' },
  { id: 'ai_inference', label: 'AI inference price', unit: '$/1M tokens (blended)', nominalWeight: 0.2, source: 'OpenRouter model list' },
  { id: 'btc_hashprice', label: 'Bitcoin hashprice', unit: '$/TH/day', nominalWeight: 0.2, source: 'blockchain.info + CoinGecko' },
  { id: 'blockspace', label: 'Ethereum blockspace stress', unit: 'EGSI (0-1000)', nominalWeight: 0.1, source: 'Congest EGSI (Ethereum blocks)' },
];

export function metaFor(id: ComponentId): ComponentMeta {
  const m = COMPONENT_META.find((c) => c.id === id);
  if (!m) throw new Error(`unknown component ${id}`);
  return m;
}
