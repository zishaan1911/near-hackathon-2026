/**
 * Live compute news from free, key-less sources (Hacker News via Algolia and
 * Google News RSS). Headlines, source names, times and links only: never
 * article text or images. Never throws; both sources down returns no items.
 */
import type { FetchImpl } from './compute/types.js';

export interface NewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  via: 'hn' | 'google';
}

export interface NewsResponse {
  asOf: string;
  items: NewsItem[];
}

export const HN_QUERIES = ['GPU', 'Nvidia', 'data center', 'AI compute', 'bitcoin mining'];
export const GOOGLE_QUERY = 'GPU prices OR "AI compute" OR "data center" OR Nvidia when:2d';
const ON_TOPIC =
  /\b(gpus?|nvidia|amd|intel|tsmc|chips?|semiconductors?|data ?cent(er|re)s?|compute|inference|llms?|ai|openai|anthropic|cloud|aws|azure|bitcoin|hashrate|mining|miners?|ethereum|gas fees?|supercomputers?)\b/i;

/** True when a headline itself mentions compute, chips, cloud, AI or mining. */
export function isOnTopic(title: string): boolean {
  return ON_TOPIC.test(title);
}

export const MAX_ITEMS = 30;
export const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const CACHE_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 8000;

export interface NewsOptions {
  fetchImpl?: FetchImpl;
  now?: () => number;
  cacheTtlMs?: number;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n: string) => safeCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decodeEntities(m[1]!).trim() : '';
}

export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Parses Google News RSS into items. Malformed entries are skipped. */
export function parseGoogleRss(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1]!;
    let title = tag(block, 'title');
    const url = safeUrl(tag(block, 'link'));
    const time = Date.parse(tag(block, 'pubDate'));
    if (!title || !url || !Number.isFinite(time)) continue;
    let source = tag(block, 'source');
    const idx = title.lastIndexOf(' - ');
    if (idx > 0) {
      const publisher = title.slice(idx + 3).trim();
      title = title.slice(0, idx).trim();
      if (!source) source = publisher;
    }
    if (!title) continue;
    out.push({
      id: `google:${url}`,
      title,
      url,
      source: source || 'Google News',
      publishedAt: new Date(time).toISOString(),
      via: 'google',
    });
  }
  return out;
}

interface HnHit {
  objectID?: unknown;
  title?: unknown;
  url?: unknown;
  created_at?: unknown;
}

/** Maps an Algolia search response to items. A null url links to the HN thread. */
export function mapHn(payload: unknown): NewsItem[] {
  const hits = (payload as { hits?: unknown } | null)?.hits;
  if (!Array.isArray(hits)) return [];
  const out: NewsItem[] = [];
  for (const h of hits as HnHit[]) {
    if (!h || typeof h.title !== 'string' || !h.title.trim() || typeof h.objectID !== 'string') continue;
    const time = typeof h.created_at === 'string' ? Date.parse(h.created_at) : NaN;
    if (!Number.isFinite(time)) continue;
    const url = safeUrl(h.url) ?? `https://news.ycombinator.com/item?id=${encodeURIComponent(h.objectID)}`;
    let source = 'Hacker News';
    try {
      source = new URL(url).hostname.replace(/^www\./, '');
      if (source === 'news.ycombinator.com') source = 'Hacker News';
    } catch {
      /* keep default */
    }
    out.push({
      id: `hn:${h.objectID}`,
      title: h.title.trim(),
      url,
      source,
      publishedAt: new Date(time).toISOString(),
      via: 'hn',
    });
  }
  return out;
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function normUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`.toLowerCase();
  } catch {
    return u;
  }
}

export function mergeItems(lists: NewsItem[][], nowMs: number): NewsItem[] {
  const all = lists
    .flat()
    .filter((i) => {
      const t = Date.parse(i.publishedAt);
      return Number.isFinite(t) && nowMs - t <= MAX_AGE_MS && t <= nowMs + 60 * 60 * 1000;
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  const out: NewsItem[] = [];
  for (const i of all) {
    const nt = normTitle(i.title);
    const nu = normUrl(i.url);
    if (seenTitles.has(nt) || seenUrls.has(nu)) continue;
    seenTitles.add(nt);
    seenUrls.add(nu);
    out.push(i);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

async function getText(fetchImpl: FetchImpl, url: string): Promise<string> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'silica-news/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchHn(fetchImpl: FetchImpl): Promise<NewsItem[]> {
  const lists = await Promise.allSettled(
    HN_QUERIES.map(async (q) => {
      const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=30&query=${encodeURIComponent(q)}`;
      // Algolia matches loosely (story text, partial words), so keep only
      // headlines that themselves mention compute.
      return mapHn(JSON.parse(await getText(fetchImpl, url))).filter((i) => isOnTopic(i.title));
    }),
  );
  const ok = lists.filter((l): l is PromiseFulfilledResult<NewsItem[]> => l.status === 'fulfilled');
  if (ok.length === 0) throw new Error('Hacker News unavailable');
  return ok.flatMap((l) => l.value);
}

async function fetchGoogle(fetchImpl: FetchImpl): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(GOOGLE_QUERY)}&hl=en-US&gl=US&ceid=US:en`;
  return parseGoogleRss(await getText(fetchImpl, url));
}

/** Returns a cached getter. Never rejects. */
export function createNewsService(opts: NewsOptions = {}): () => Promise<NewsResponse> {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  let cached: { at: number; value: NewsResponse } | null = null;
  let inflight: Promise<NewsResponse> | null = null;

  async function load(): Promise<NewsResponse> {
    const [hn, google] = await Promise.allSettled([fetchHn(fetchImpl), fetchGoogle(fetchImpl)]);
    const t = now();
    const items = mergeItems(
      [hn.status === 'fulfilled' ? hn.value : [], google.status === 'fulfilled' ? google.value : []],
      t,
    );
    return { asOf: new Date(t).toISOString(), items };
  }

  return async () => {
    const t = now();
    if (cached && t - cached.at < ttl) return cached.value;
    if (!inflight) {
      inflight = load()
        .catch((): NewsResponse => ({ asOf: new Date(now()).toISOString(), items: [] }))
        .then((value) => {
          // Don't pin an empty result for the full TTL: retry sooner.
          if (value.items.length > 0) cached = { at: now(), value };
          return value;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}
