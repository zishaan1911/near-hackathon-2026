import type { ComponentId } from './types.js';

export type GpuId = 'h100' | 'a100' | 'rtx4090';

/** GPU products of the gpu_rental component, with product weights and venue-specific names. */
export const GPU_PRODUCTS: ReadonlyArray<{
  id: GpuId;
  label: string;
  weight: number;
  vastName: string;
  runpodId: string;
  akashModel: string;
}> = [
  { id: 'h100', label: 'NVIDIA H100', weight: 0.5, vastName: 'H100 SXM', runpodId: 'NVIDIA H100 80GB HBM3', akashModel: 'h100' },
  { id: 'a100', label: 'NVIDIA A100', weight: 0.3, vastName: 'A100 SXM4', runpodId: 'NVIDIA A100-SXM4-80GB', akashModel: 'a100' },
  { id: 'rtx4090', label: 'NVIDIA RTX 4090', weight: 0.2, vastName: 'RTX 4090', runpodId: 'NVIDIA GeForce RTX 4090', akashModel: 'rtx4090' },
];

export const GPU_VENUES: readonly string[] = ['vast', 'runpod', 'akash'];

/** Fixed OpenRouter model basket: 8 labs, paid, non-preview. */
export const MODEL_BASKET: readonly string[] = [
  'openai/gpt-4o-mini',
  'anthropic/claude-haiku-4.5',
  'google/gemini-3.1-flash-lite',
  'meta-llama/llama-3.3-70b-instruct',
  'mistralai/mistral-large-2512',
  'deepseek/deepseek-v3.2',
  'qwen/qwen3.6-plus',
  'x-ai/grok-4.3',
];

export interface CloudSpec {
  venue: 'aws' | 'azure';
  sku: string;
  product: string;
  /** GPUs (or vCPUs) per instance; the instance price is divided by it. */
  units: number;
}

export const CLOUD_GPU_SPECS: readonly CloudSpec[] = [
  { venue: 'azure', sku: 'Standard_NC24ads_A100_v4', product: 'a100', units: 1 },
  { venue: 'azure', sku: 'Standard_NC40ads_H100_v5', product: 'h100', units: 1 },
  { venue: 'aws', sku: 'g5.xlarge', product: 'a10g', units: 1 },
  { venue: 'aws', sku: 'g6.xlarge', product: 'l4', units: 1 },
  { venue: 'aws', sku: 'p4d.24xlarge', product: 'a100', units: 8 },
  { venue: 'aws', sku: 'p5.48xlarge', product: 'h100', units: 8 },
];

export const CLOUD_CPU_SPECS: readonly CloudSpec[] = [
  { venue: 'aws', sku: 'm7i.xlarge', product: 'general_x86', units: 4 },
  { venue: 'azure', sku: 'Standard_D4s_v5', product: 'general_x86', units: 4 },
  { venue: 'aws', sku: 'c7i.xlarge', product: 'compute_x86', units: 4 },
  { venue: 'aws', sku: 'r7i.xlarge', product: 'memory_x86', units: 4 },
  { venue: 'aws', sku: 'm7g.xlarge', product: 'general_arm', units: 4 },
];

export const AZURE_REGIONS: readonly string[] = ['eastus', 'eastus2', 'westus2', 'southcentralus'];
export const AWS_US_REGIONS: readonly string[] = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'];

export function cloudQuoteKey(component: 'cloud_gpu' | 'cloud_cpu', spec: CloudSpec): string {
  return `${component}/${spec.product}/${spec.venue}-${spec.sku.toLowerCase()}`;
}

/** Product weights; products not listed (or components not listed) are equally weighted. */
export const PRODUCT_WEIGHTS: Readonly<Partial<Record<ComponentId, Readonly<Record<string, number>>>>> = {
  gpu_rental: Object.fromEntries(GPU_PRODUCTS.map((g) => [g.id, g.weight])),
};
