/** The four routes of the app, matched from a pathname. No dependency. */
export type RouteId = 'home' | 'index' | 'trade' | 'portfolio' | 'notFound';

export const PATHS = {
  home: '/',
  index: '/compute',
  trade: '/trade',
  portfolio: '/portfolio',
} as const;

export function matchRoute(pathname: string): RouteId {
  const path = (pathname.split(/[?#]/)[0] ?? '').replace(/\/+$/, '').toLowerCase();
  if (path === '' || path === '/index.html') return 'home';
  if (path === '/compute') return 'index';
  if (path === '/trade') return 'trade';
  if (path === '/portfolio') return 'portfolio';
  return 'notFound';
}

/** Routes that need the wallet code, which is loaded only for them. */
export function needsWallet(route: RouteId): boolean {
  return route === 'trade' || route === 'portfolio';
}
