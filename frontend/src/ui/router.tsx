import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { matchRoute, type RouteId } from '../lib/routes';

const CHANGE = 'silica:navigate';

function subscribe(notify: () => void) {
  window.addEventListener('popstate', notify);
  window.addEventListener(CHANGE, notify);
  window.addEventListener('hashchange', notify);
  return () => {
    window.removeEventListener('popstate', notify);
    window.removeEventListener(CHANGE, notify);
    window.removeEventListener('hashchange', notify);
  };
}

export function navigate(to: string) {
  const url = new URL(to, window.location.href);
  const samePage = url.pathname === window.location.pathname;
  if (url.href !== window.location.href) window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(CHANGE));
  if (url.hash) {
    // Let the new page render before looking for the anchor.
    requestAnimationFrame(() => document.getElementById(url.hash.slice(1))?.scrollIntoView());
  } else if (!samePage) {
    window.scrollTo(0, 0);
  }
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}

export function useRoute(): RouteId {
  return matchRoute(usePathname());
}

/** An in-app link. Modified clicks and new-tab clicks keep their browser behaviour. */
export function Link({
  to,
  onClick,
  ...rest
}: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  function handle(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  }
  return <a href={to} onClick={handle} {...rest} />;
}
