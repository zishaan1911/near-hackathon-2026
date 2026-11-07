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
