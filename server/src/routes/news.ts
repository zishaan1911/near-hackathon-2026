/** GET /api/v1/news: compute headlines from Hacker News and Google News. Never throws. */
import type { FastifyInstance } from 'fastify';
import { createNewsService, type NewsOptions, type NewsResponse } from '../news.js';

export const NEWS_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=600';

export function registerNewsRoutes(
  app: FastifyInstance,
  opts: NewsOptions & { getNews?: () => Promise<NewsResponse> } = {},
): void {
  const getNews = opts.getNews ?? createNewsService(opts);
  app.get('/api/v1/news', async (_request, reply) => {
    const body = await getNews();
    return reply.header('Cache-Control', NEWS_CACHE_CONTROL).send(body);
  });
}
