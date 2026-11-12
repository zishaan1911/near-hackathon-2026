/** Countdown text for a market expiry; null when expired or unknown. */
export function formatCountdown(expiryMs: number, now = Date.now()): string | null {
  const remaining = expiryMs - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const total = Math.floor(remaining / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "12s ago" / "4m ago" for an epoch-ms timestamp; null when unknown. */
export function formatAge(updatedMs: number | undefined, now = Date.now()): string | null {
  if (updatedMs === undefined || !Number.isFinite(updatedMs)) return null;
  const seconds = Math.max(0, Math.floor((now - updatedMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** Index level change vs its base, as a signed percent; null when unknown. */
export function percentVsBase(level: number | null | undefined, base: number): number | null {
  if (level === null || level === undefined || !Number.isFinite(level) || !Number.isFinite(base) || base === 0) return null;
  return ((level - base) / base) * 100;
}
