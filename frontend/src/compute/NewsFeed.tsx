import { useEffect, useState } from 'react';
import { getNews, type NewsItem } from '../lib/api';
import { Reveal, Skeleton } from '../ui/bits';

const REFRESH_MS = 5 * 60_000;

export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Live compute headlines. Hides itself when there is nothing to show. */
export function NewsFeed({ limit, compact = false }: { limit?: number; compact?: boolean }) {
  const [items, setItems] = useState<NewsItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      getNews()
        .then((r) => alive && setItems(r.items))
        // A failed refresh keeps the last good list; a failed first load hides the section.
        .catch(() => alive && setItems((prev) => prev ?? []));
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  if (items && items.length === 0) return null;
  const shown = items ? (limit ? items.slice(0, limit) : items) : null;
  const rows = limit ?? 8;

  return (
    <section className="wrap section">
      <Reveal>
        <div className="section-head">
          <h2 className="title">
            <span>Compute news,</span> <span className="lo">live.</span>
          </h2>
        </div>
        {shown ? (
          <ul className={`news-list${compact ? ' news-compact' : ''}`}>
            {shown.map((item) => (
              <li key={item.id} className="news-row">
                <a href={item.url} target="_blank" rel="noopener noreferrer" className="news-title">
                  {item.title}
                </a>
                <span className="news-meta muted small">
                  {item.source} · {relativeTime(item.publishedAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className={`news-list${compact ? ' news-compact' : ''}`} aria-hidden="true">
            {Array.from({ length: rows }, (_, i) => (
              <li key={i} className="news-row">
                <Skeleton className="news-skel" />
              </li>
            ))}
          </ul>
        )}
        <p className="muted small news-note">Headlines from Hacker News and Google News. Links open the original publisher.</p>
      </Reveal>
    </section>
  );
}
