import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createNewsService, mapHn, mergeItems, parseGoogleRss, type NewsItem } from '../src/news.js';
import { NEWS_CACHE_CONTROL, registerNewsRoutes } from '../src/routes/news.js';
import type { FetchImpl } from '../src/compute/types.js';

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const rfc = (h: number) => new Date(NOW - h * 3600_000).toUTCString();

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Nvidia &amp; AMD &quot;race&quot; on GPUs - Reuters</title><link>https://news.google.com/rss/articles/abc</link><pubDate>${rfc(2)}</pubDate><source url="https://reuters.com">Reuters</source></item>
<item><title><![CDATA[Data center demand - up - The Verge]]></title><link>https://news.google.com/rss/articles/def</link><pubDate>${rfc(5)}</pubDate></item>
<item><title>Bad link - X</title><link>javascript:alert(1)</link><pubDate>${rfc(1)}</pubDate></item>
</channel></rss>`;

function hnBody(hits: unknown[]) {
  return JSON.stringify({ hits });
}

function fakeFetch(opts: { hn?: unknown[] | 'fail'; rss?: string | 'fail' }): FetchImpl & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    if (url.includes('hn.algolia.com')) {
      if (opts.hn === 'fail') throw new Error('down');
      return new Response(hnBody(opts.hn ?? []), { status: 200 });
    }
    if (opts.rss === 'fail') return new Response('nope', { status: 503 });
    return new Response(opts.rss ?? '<rss></rss>', { status: 200 });
  }) as FetchImpl & { calls: string[] };
  f.calls = calls;
  return f;
}

describe('parseGoogleRss', () => {
  it('decodes entities, splits the publisher and skips non-http links', () => {
    const items = parseGoogleRss(RSS);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'Nvidia & AMD "race" on GPUs',
      source: 'Reuters',
      via: 'google',
      url: 'https://news.google.com/rss/articles/abc',
    });
    expect(items[1]).toMatchObject({ title: 'Data center demand - up', source: 'The Verge' });
    expect(items[0]!.publishedAt).toBe(hoursAgo(2));
  });
});

describe('mapHn', () => {
  it('maps hits and links null urls to the HN thread', () => {
    const items = mapHn({
      hits: [
        { objectID: '1', title: 'Story A', url: 'https://www.example.com/a', created_at: hoursAgo(1) },
        { objectID: '2', title: 'Ask HN: GPUs?', url: null, created_at: hoursAgo(2) },
        { objectID: '3', title: 'Bad', url: 'ftp://x', created_at: hoursAgo(2) },
        { objectID: '4', title: '', url: 'https://x.com', created_at: hoursAgo(2) },
      ],
    });
    expect(items.map((i) => i.url)).toEqual([
      'https://www.example.com/a',
      'https://news.ycombinator.com/item?id=2',
      'https://news.ycombinator.com/item?id=3',
    ]);
    expect(items[0]!.source).toBe('example.com');
    expect(items[1]!.source).toBe('Hacker News');
    expect(items.every((i) => i.via === 'hn')).toBe(true);
  });
  it('tolerates junk', () => {
    expect(mapHn(null)).toEqual([]);
    expect(mapHn({ hits: 'x' })).toEqual([]);
  });
});

describe('mergeItems', () => {
  const mk = (id: string, title: string, url: string, h: number): NewsItem => ({
    id,
    title,
    url,
    source: 's',
    publishedAt: hoursAgo(h),
    via: 'hn',
  });
  it('dedupes by normalised title and url, sorts newest first', () => {
    const out = mergeItems(
      [
        [mk('a', 'Nvidia: GPUs!', 'https://a.com/x', 3), mk('b', 'Other', 'https://b.com/y/', 1)],
        [mk('c', 'nvidia gpus', 'https://c.com/z', 2), mk('d', 'Third', 'https://www.b.com/y', 4)],
      ],
      NOW,
    );
    expect(out.map((i) => i.id)).toEqual(['b', 'c']);
  });
  it('drops items older than three days and caps at 30', () => {
    const old = mk('old', 'Old', 'https://o.com', 24 * 3 + 1);
    const many = Array.from({ length: 40 }, (_, i) => mk(`n${i}`, `T${i}`, `https://n.com/${i}`, i * 0.1));
    const out = mergeItems([[old, ...many]], NOW);
    expect(out).toHaveLength(30);
    expect(out.find((i) => i.id === 'old')).toBeUndefined();
  });
});

describe('createNewsService', () => {
  it('still returns the other source when one fails', async () => {
    const hn = createNewsService({ fetchImpl: fakeFetch({ hn: 'fail', rss: RSS }), now: () => NOW });
    expect((await hn()).items.map((i) => i.via)).toEqual(['google', 'google']);
    const rss = createNewsService({
      fetchImpl: fakeFetch({ hn: [{ objectID: '9', title: 'GPU prices fall', url: null, created_at: hoursAgo(1) }, { objectID: '10', title: 'USDA Crop Progress Report', url: null, created_at: hoursAgo(1) }], rss: 'fail' }),
      now: () => NOW,
    });
    // The off-topic headline is filtered out.
    expect((await rss()).items.map((i) => i.id)).toEqual(['hn:9']);
  });

  it('returns empty items when both are down', async () => {
    const svc = createNewsService({ fetchImpl: fakeFetch({ hn: 'fail', rss: 'fail' }), now: () => NOW });
    const res = await svc();
    expect(res.items).toEqual([]);
    expect(res.asOf).toBe(new Date(NOW).toISOString());
  });

  it('caches for ten minutes', async () => {
    const f = fakeFetch({ rss: RSS });
    const clock = { t: NOW };
    const svc = createNewsService({ fetchImpl: f, now: () => clock.t });
    await svc();
    const n = f.calls.length;
    expect(n).toBe(6); // five HN queries + one RSS
    clock.t += 9 * 60_000;
    await svc();
    expect(f.calls.length).toBe(n);
    clock.t += 2 * 60_000;
    await svc();
    expect(f.calls.length).toBe(2 * n);
  });
});

describe('GET /api/v1/news', () => {
  it('returns the documented shape and cache header', async () => {
    const app = Fastify();
    registerNewsRoutes(app, { fetchImpl: fakeFetch({ rss: RSS }), now: () => NOW });
    const res = await app.inject({ method: 'GET', url: '/api/v1/news' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(NEWS_CACHE_CONTROL);
    const body = res.json();
    expect(typeof body.asOf).toBe('string');
    expect(Object.keys(body.items[0]).sort()).toEqual(['id', 'publishedAt', 'source', 'title', 'url', 'via']);
  });
});
