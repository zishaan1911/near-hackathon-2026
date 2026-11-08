/** GPU basket for the Vast.ai component (gpu_name strings verified live). */
export const GPU_BASKET: ReadonlyArray<{ name: string; weight: number }> = [
  { name: 'H100 SXM', weight: 0.5 },
  { name: 'A100 SXM4', weight: 0.3 },
  { name: 'RTX 4090', weight: 0.2 },
];

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

export const AZURE_SKUS: readonly string[] = ['Standard_NC24ads_A100_v4', 'Standard_NC40ads_H100_v5'];
export const AZURE_REGIONS: readonly string[] = ['eastus', 'eastus2', 'westus2', 'southcentralus'];
