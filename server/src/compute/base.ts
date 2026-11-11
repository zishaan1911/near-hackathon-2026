import type { ComponentId } from './types.js';

/** Fixed base date at which the index is defined as 1000. */
export const BASE_DATE = '2026-11-11';

/**
 * Base price per quote key (index = 1000 when every quote equals its base),
 * from a live snapshot taken 2026-11-11T05:47:18.013Z by
 * scripts/snapshotCompute.ts --write-base. Part of methodology v2.0: change
 * only with a new methodology version.
 */
export const BASE_QUOTES: Record<string, number> = {
  'ai/anthropic/claude-haiku-4.5': 2,
  'ai/deepseek/deepseek-v3.2': 0.29,
  'ai/google/gemini-3.1-flash-lite': 0.5625,
  'ai/meta-llama/llama-3.3-70b-instruct': 0.71,
  'ai/mistralai/mistral-large-2512': 0.75,
  'ai/openai/gpt-4o-mini': 0.2625,
  'ai/qwen/qwen3.6-plus': 0.73125,
  'ai/x-ai/grok-4.3': 1.5625,
  'btc/hashprice': 0.035437672,
  'cloud_cpu/compute_x86/aws-c7i.xlarge': 0.0197375,
  'cloud_cpu/general_arm/aws-m7g.xlarge': 0.014475,
  'cloud_cpu/general_x86/aws-m7i.xlarge': 0.01985,
  'cloud_cpu/general_x86/azure-standard_d4s_v5': 0.010379375,
  'cloud_cpu/memory_x86/aws-r7i.xlarge': 0.024175,
  'cloud_gpu/a100/aws-p4d.24xlarge': 0.775625,
  'cloud_gpu/a100/azure-standard_nc24ads_a100_v4': 0.746354,
  'cloud_gpu/a10g/aws-g5.xlarge': 0.4461,
  'cloud_gpu/h100/aws-p5.48xlarge': 4.4648375,
  'cloud_gpu/h100/azure-standard_nc40ads_h100_v5': 2.731594,
  'cloud_gpu/l4/aws-g6.xlarge': 0.1046,
  'eth/blockspace': 0.12317898,
  'gpu/a100/akash': 1.67,
  'gpu/a100/runpod': 1.79,
  'gpu/a100/vast': 0.9237037,
  'gpu/h100/akash': 2.73,
  'gpu/h100/runpod': 3.99,
  'gpu/h100/vast': 3.3551444,
  'gpu/rtx4090/runpod': 0.89,
  'gpu/rtx4090/vast': 0.49288889,
};

/** Representative base price per component (median of its quotes), display only. */
export const BASE_VALUES: Record<ComponentId, number> = {
  gpu_rental: 1.73,
  cloud_gpu_spot: 0.7609895,
  cloud_cpu_spot: 0.0197375,
  ai_inference: 0.720625,
  btc_hashprice: 0.035437672,
  blockspace: 0.12317898,
};
