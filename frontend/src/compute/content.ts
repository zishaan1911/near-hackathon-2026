import type { ComputeComponentId } from '../lib/api';
import imageCredits from '../lib/imageCredits.json';

export interface ImageCredit {
  slug: string;
  kind: string;
  file: string;
  title: string;
  author: string;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string;
}

export interface ImageSpec {
  slug: string;
  src: string;
  width: number;
  height: number;
  alt: string;
}

function image(slug: string, width: number, height: number, alt: string): ImageSpec {
  return { slug, src: `/img/compute/${slug}.jpg`, width, height, alt };
}

export const HERO_IMAGE = image(
  'hero-frontier',
  1920,
  1280,
  'Black Frontier supercomputer cabinets in a long row under yellow cable trays',
);

export interface PillarSpec {
  id: ComputeComponentId;
  label: string;
  objectPosition: string;
  image: ImageSpec;
}

export const PILLARS: readonly PillarSpec[] = [
  {
    id: 'gpu_rental',
    label: 'GPU rental',
    objectPosition: '50% 50%',
    image: image('wafer', 960, 640, 'Close-up of a silicon wafer, its dies refracting light'),
  },
  {
    id: 'cloud_gpu_spot',
    label: 'Cloud GPU spot',
    objectPosition: '62% 50%',
    image: image('summit', 960, 540, 'Rows of Summit supercomputer cabinets in a data hall'),
  },
  {
    id: 'cloud_cpu_spot',
    label: 'Cloud CPU spot',
    objectPosition: '50% 38%',
    image: image('nersc-rack', 960, 1445, 'The rear of a server rack, with cabled rows of servers'),
  },
  {
    id: 'ai_inference',
    label: 'AI inference',
    objectPosition: '55% 14%',
    image: image('robot', 960, 1275, 'A blue and silver humanoid robot on display in a museum'),
  },
  {
    id: 'btc_hashprice',
    label: 'Bitcoin hashprice',
    objectPosition: '72% 45%',
    image: image('mining-farm', 960, 540, 'A dark warehouse wall of Bitcoin miners with lit LEDs'),
  },
  {
    id: 'blockspace',
    label: 'Ethereum blockspace',
    objectPosition: '58% 32%',
    image: image('cables', 960, 1707, 'Coils of colored network cable hanging in a server rack'),
  },
];

/** Every image slug the site renders; the credits list is derived from this. */
export const USED_IMAGE_SLUGS: readonly string[] = [
  HERO_IMAGE.slug,
  ...PILLARS.map((p) => p.image.slug),
];

export const IMAGE_CREDITS: readonly ImageCredit[] = (imageCredits as ImageCredit[]).filter((c) =>
  USED_IMAGE_SLUGS.includes(c.slug),
);

export const SOURCES: ReadonlyArray<{ id: ComputeComponentId; label: string; text: string }> = [
  { id: 'gpu_rental', label: 'GPU rental', text: 'Vast.ai, RunPod and Akash offers for H100, A100 and RTX 4090.' },
  { id: 'cloud_gpu_spot', label: 'Cloud GPU spot', text: 'AWS and Azure spot prices for GPU instances, per GPU.' },
  { id: 'cloud_cpu_spot', label: 'Cloud CPU spot', text: 'AWS and Azure spot prices for general-purpose instances, per vCPU.' },
  { id: 'ai_inference', label: 'AI inference', text: "OpenRouter's model list: a fixed basket of eight models from eight labs." },
  { id: 'btc_hashprice', label: 'Bitcoin hashprice', text: 'Network hash rate from blockchain.info, with BTC/USD from CoinGecko.' },
  { id: 'blockspace', label: 'Ethereum blockspace', text: 'Base fees from Ethereum JSON-RPC with ETH/USD, as a seven-day median.' },
];

export function creditFor(slug: string): ImageCredit | undefined {
  return IMAGE_CREDITS.find((c) => c.slug === slug);
}
