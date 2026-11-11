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

export const BREAK_DGX = image(
  'dgx',
  960,
  540,
  'An NVIDIA DGX system with a metal foam front panel, on a wooden table',
);

export const BREAK_AISLE = image(
  'frontier-aisle',
  960,
  787,
  'An aisle of Frontier supercomputer cabinets with bundles of blue coolant lines',
);

export interface PillarSpec {
  id: ComputeComponentId;
  label: string;
  /** Grid column span on wide screens. */
  span: 5 | 7;
  objectPosition: string;
  image: ImageSpec;
}

export const PILLARS: readonly PillarSpec[] = [
  {
    id: 'gpu_rental',
    label: 'GPU rental',
    span: 7,
    objectPosition: '50% 50%',
    image: image('wafer', 960, 640, 'Close-up of a silicon wafer, its dies refracting light'),
  },
  {
    id: 'cloud_gpu_spot',
    label: 'Cloud GPU spot',
    span: 5,
    objectPosition: '62% 50%',
    image: image('summit', 960, 540, 'Rows of Summit supercomputer cabinets in a data hall'),
  },
  {
    id: 'cloud_cpu_spot',
    label: 'Cloud CPU spot',
    span: 5,
    objectPosition: '50% 38%',
    image: image('nersc-rack', 960, 1445, 'The rear of a server rack, with cabled rows of servers'),
  },
  {
    id: 'ai_inference',
    label: 'AI inference',
    span: 7,
    objectPosition: '55% 14%',
    image: image('robot', 960, 1275, 'A blue and silver humanoid robot on display in a museum'),
  },
  {
    id: 'btc_hashprice',
    label: 'Bitcoin hashprice',
    span: 7,
    objectPosition: '72% 45%',
    image: image('mining-farm', 960, 540, 'A dark warehouse wall of Bitcoin miners with lit LEDs'),
  },
  {
    id: 'blockspace',
    label: 'Ethereum blockspace',
    span: 5,
    objectPosition: '58% 32%',
    image: image('cables', 960, 1707, 'Coils of colored network cable hanging in a server rack'),
  },
];

export interface PersonSpec {
  slug: string;
  name: string;
  company: string;
  line: string;
  width: number;
  height: number;
  objectPosition: string;
  /** Uniform crop-in for photos where the face is small in the frame. */
  zoom?: { scale: number; origin: string };
}

export const PEOPLE: readonly PersonSpec[] = [
  { slug: 'jensen-huang', name: 'Jensen Huang', company: 'NVIDIA', line: 'Makes the GPUs on the board above.', width: 500, height: 667, objectPosition: '50% 25%' },
  { slug: 'lisa-su', name: 'Lisa Su', company: 'AMD', line: 'AMD chips power Frontier, the machine in our hero image.', width: 500, height: 750, objectPosition: '43% 0%', zoom: { scale: 1.55, origin: '43% 30%' } },
  { slug: 'satya-nadella', name: 'Satya Nadella', company: 'Microsoft', line: 'Azure spot prices feed this index.', width: 500, height: 639, objectPosition: '50% 30%' },
  { slug: 'sam-altman', name: 'Sam Altman', company: 'OpenAI', line: 'OpenAI models are in the inference basket.', width: 500, height: 500, objectPosition: '52% 50%' },
  { slug: 'dario-amodei', name: 'Dario Amodei', company: 'Anthropic', line: 'Anthropic models are in the inference basket.', width: 500, height: 800, objectPosition: '41% 0%', zoom: { scale: 1.35, origin: '41% 25%' } },
  { slug: 'sundar-pichai', name: 'Sundar Pichai', company: 'Google', line: 'Gemini models are in the inference basket.', width: 500, height: 750, objectPosition: '50% 30%' },
  { slug: 'demis-hassabis', name: 'Demis Hassabis', company: 'Google DeepMind', line: 'Builds the Gemini models.', width: 500, height: 489, objectPosition: '55% 50%', zoom: { scale: 1.35, origin: '50% 28%' } },
  { slug: 'mark-zuckerberg', name: 'Mark Zuckerberg', company: 'Meta', line: 'Llama models are in the inference basket.', width: 500, height: 666, objectPosition: '50% 0%' },
  { slug: 'elon-musk', name: 'Elon Musk', company: 'xAI', line: 'Grok models are in the inference basket.', width: 500, height: 660, objectPosition: '50% 5%' },
];

export const PEOPLE_DISCLAIMER =
  'Shown for editorial context only. These people and their companies are not affiliated with Congest and do not endorse it.';

/** Every image slug the page renders; the credits list is derived from this. */
export const USED_IMAGE_SLUGS: readonly string[] = [
  HERO_IMAGE.slug,
  BREAK_DGX.slug,
  BREAK_AISLE.slug,
  ...PILLARS.map((p) => p.image.slug),
  ...PEOPLE.map((p) => p.slug),
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
