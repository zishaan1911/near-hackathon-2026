const DISPLAY_DECIMALS = 2;
const WHOLE_UNITS = /^\d+$/;
const DECIMAL_TEXT = /^(\d+)(?:\.(\d+))?$/;

/**
 * Formats a U128 base-unit string (e.g. "1500000" for 1.5 tUSDC at 6
 * decimals) as a display amount with two decimal places, rounding half up.
 * Integer math keeps large balances exact.
 */
export function formatTokenAmount(baseUnits: string, decimals = 6): string {
  if (!WHOLE_UNITS.test(baseUnits)) return '—';

  const unit = 10n ** BigInt(decimals);
  const cents = (BigInt(baseUnits) * 10n ** BigInt(DISPLAY_DECIMALS) + unit / 2n) / unit;
  const whole = cents / 10n ** BigInt(DISPLAY_DECIMALS);
  const fraction = cents % 10n ** BigInt(DISPLAY_DECIMALS);

  return `${whole}.${fraction.toString().padStart(DISPLAY_DECIMALS, '0')}`;
}

/**
 * Parses user-entered decimal text (e.g. "1.5") into a U128 base-unit string
 * ("1500000"). Returns null for anything that is not a plain non-negative
 * decimal, or that has more fractional digits than the token supports.
 */
export function parseTokenAmount(text: string, decimals = 6): string | null {
  const match = DECIMAL_TEXT.exec(text.trim());
  if (!match) return null;

  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) return null;

  return (whole + fraction.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
}

/** "1234.5" -> "1,234.5": thousands separators for a plain decimal string. */
export function groupThousands(text: string): string {
  const [whole = '', fraction] = text.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Base units as a grouped amount; with `trim`, whole amounts drop ".00". */
export function formatTusdc(baseUnits: string | bigint, trim = false): string {
  const text = formatTokenAmount(String(baseUnits));
  if (text === '—') return text;
  return groupThousands(trim && text.endsWith('.00') ? text.slice(0, -3) : text);
}

/** A signed amount such as "+12.40" or "-3.00". */
export function formatSigned(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Number(value.toFixed(digits));
  const body = groupThousands(Math.abs(rounded).toFixed(digits));
  return rounded > 0 ? `+${body}` : rounded < 0 ? `-${body}` : body;
}
