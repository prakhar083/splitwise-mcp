/**
 * Money handling for Splitwise amounts.
 *
 * All arithmetic happens on integer minor units (cents, paise, yen, fils) held
 * as bigint. Floats never touch a balance: decimal strings are parsed digit by
 * digit, and splits use a largest-remainder allocation so the shares always sum
 * to exactly the total.
 */

export class MoneyError extends Error {
  override name = 'MoneyError';
}

const SUPPORTED_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

/** Normalises and validates an ISO 4217 currency code. */
export function normalizeCurrency(code: string): string {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) {
    throw new MoneyError(`"${code}" is not a currency code. Use a 3-letter ISO 4217 code such as USD, EUR or INR.`);
  }
  if (!SUPPORTED_CURRENCIES.has(upper)) {
    throw new MoneyError(`Unknown currency code "${upper}". Use a 3-letter ISO 4217 code such as USD, EUR or INR.`);
  }
  return upper;
}

/** Number of decimal places the currency uses (USD 2, JPY 0, KWD 3). */
export function currencyExponent(code: string): number {
  const currency = normalizeCurrency(code);
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/**
 * Like {@link currencyExponent}, but never throws. Used for amounts coming back
 * from Splitwise, which may use codes outside ICU's table.
 */
export function exponentOrDefault(code: string | null | undefined): number {
  try {
    return code ? currencyExponent(code) : 2;
  } catch {
    return 2;
  }
}

const DECIMAL = /^([+-])?(\d*)(?:\.(\d*))?$/;

/**
 * Parses a user-supplied amount into minor units. Rejects anything that is not
 * a plain positive decimal or that carries more precision than the currency
 * allows ("10.005 USD" is an error, not a silent rounding).
 */
export function parseAmount(input: string | number, currency: string, options: { allowZero?: boolean } = {}): bigint {
  const exponent = currencyExponent(currency);
  const text = typeof input === 'number' ? numberToPlainString(input) : stripGrouping(input);
  const match = DECIMAL.exec(text);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new MoneyError(`"${input}" is not a valid amount.`);
  }
  const [, sign, whole = '', frac = ''] = match;
  if (sign === '-') throw new MoneyError(`Amount must be positive, got ${input}.`);
  const fracDigits = frac.replace(/0+$/, '');
  if (fracDigits.length > exponent) {
    throw new MoneyError(
      `${input} has more decimal places than ${currency.toUpperCase()} allows (${exponent}).`,
    );
  }
  const minor = BigInt((whole || '0') + fracDigits.padEnd(exponent, '0'));
  if (minor === 0n && !options.allowZero) throw new MoneyError(`Amount must be greater than zero, got ${input}.`);
  return minor;
}

/**
 * Parses an amount string returned by Splitwise ("12.5", "-4.33", "0.0").
 * Lenient about trailing precision: rounds half away from zero.
 */
export function parseApiAmount(input: string | number | null | undefined, currency: string | null | undefined): bigint {
  if (input === null || input === undefined || input === '') return 0n;
  const exponent = exponentOrDefault(currency);
  const text = typeof input === 'number' ? numberToPlainString(input) : input.trim();
  const match = DECIMAL.exec(text);
  if (!match) throw new MoneyError(`Unexpected amount from Splitwise: "${input}"`);
  const [, sign, whole = '', frac = ''] = match;
  const kept = frac.slice(0, exponent).padEnd(exponent, '0');
  let minor = BigInt((whole || '0') + kept);
  const next = frac.charAt(exponent);
  if (next !== '' && Number(next) >= 5) minor += 1n;
  return sign === '-' ? -minor : minor;
}

/**
 * Removes thousands separators, but only in the unambiguous "1,234,567.89"
 * form. "1,5" could mean 1.5 or 15, so it is rejected rather than guessed.
 */
function stripGrouping(input: string): string {
  const text = input.trim().replace(/\s/g, '');
  if (!text.includes(',')) return text;
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(text)) return text.replace(/,/g, '');
  throw new MoneyError(`"${input}" is ambiguous. Use a dot for decimals and no separators, e.g. 1234.50.`);
}

/** Formats minor units as a plain decimal string ("1234" USD -> "12.34"). */
export function formatMinor(minor: bigint, currency: string): string {
  const exponent = exponentOrDefault(currency);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const frac = digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${whole}${exponent > 0 ? `.${frac}` : ''}`;
}

/**
 * Splits `total` across `weights` so that shares are proportional to the
 * weights and sum to exactly `total` (Hamilton / largest-remainder method).
 *
 * Every share gets floor(total * w / sum(w)). The leftover units, always fewer
 * than the number of shares, go one each to the shares with the largest
 * fractional remainders. Ties go to the earlier position, which makes the
 * result fully deterministic for a given input order.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) throw new MoneyError('Cannot split an amount between zero people.');
  if (total < 0n) throw new MoneyError('Cannot split a negative amount.');
  if (weights.some((w) => w < 0n)) throw new MoneyError('Split weights must not be negative.');
  const weightSum = weights.reduce((a, b) => a + b, 0n);
  if (weightSum === 0n) throw new MoneyError('Split weights must not all be zero.');

  const shares = weights.map((w) => (total * w) / weightSum);
  const remainders = weights.map((w, index) => ({ index, rem: (total * w) % weightSum }));
  let leftover = total - shares.reduce((a, b) => a + b, 0n);

  remainders.sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  for (const { index } of remainders) {
    if (leftover === 0n) break;
    shares[index]! += 1n;
    leftover -= 1n;
  }
  return shares;
}

/** Equal split. The first `total % n` people (in the order given) pay one extra minor unit. */
export function splitEqually(total: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 1) throw new MoneyError('Cannot split an amount between zero people.');
  return allocate(total, Array.from({ length: count }, () => 1n));
}

/** Percentages are accepted with up to this many decimal places (33.3333%). */
const PERCENT_DECIMALS = 4;
const PERCENT_SCALE = 10n ** BigInt(PERCENT_DECIMALS);

export function parsePercent(input: string | number): bigint {
  const text = typeof input === 'number' ? numberToPlainString(input) : input.trim().replace(/%$/, '');
  const match = DECIMAL.exec(text);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) throw new MoneyError(`"${input}" is not a valid percentage.`);
  const [, sign, whole = '', frac = ''] = match;
  if (sign === '-') throw new MoneyError(`Percentages must not be negative, got ${input}.`);
  const fracDigits = frac.replace(/0+$/, '');
  if (fracDigits.length > PERCENT_DECIMALS) {
    throw new MoneyError(`Percentages support at most ${PERCENT_DECIMALS} decimal places, got ${input}.`);
  }
  return BigInt((whole || '0') + fracDigits.padEnd(PERCENT_DECIMALS, '0'));
}

/**
 * Percentage split. Percentages must add up to exactly 100. Rounding leftovers
 * go to the largest fractional remainders, so 3 x 33.3333% of $100 yields
 * 33.34 / 33.33 / 33.33, never a total of 99.99 or 100.01.
 */
export function splitByPercentages(total: bigint, percents: readonly (string | number)[]): bigint[] {
  const scaled = percents.map(parsePercent);
  const sum = scaled.reduce((a, b) => a + b, 0n);
  const hundred = 100n * PERCENT_SCALE;
  if (sum !== hundred) {
    throw new MoneyError(`Percentages must add up to 100, but they add up to ${formatScaled(sum)}.`);
  }
  return allocate(total, scaled);
}

/** Exact split. Validates that the given shares add up to the total, to the minor unit. */
export function checkExactShares(total: bigint, shares: readonly bigint[], currency: string): bigint[] {
  if (shares.length === 0) throw new MoneyError('Provide at least one share.');
  const sum = shares.reduce((a, b) => a + b, 0n);
  if (sum !== total) {
    const diff = total - sum;
    throw new MoneyError(
      `Shares add up to ${formatMinor(sum, currency)} but the cost is ${formatMinor(total, currency)} ` +
        `(${diff > 0n ? 'short by' : 'over by'} ${formatMinor(diff > 0n ? diff : -diff, currency)} ${currency}).`,
    );
  }
  return [...shares];
}

function formatScaled(value: bigint): string {
  const digits = value.toString().padStart(PERCENT_DECIMALS + 1, '0');
  const whole = digits.slice(0, -PERCENT_DECIMALS);
  const frac = digits.slice(-PERCENT_DECIMALS).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** Converts a JS number to a non-exponential decimal string. */
function numberToPlainString(value: number): string {
  if (!Number.isFinite(value)) throw new MoneyError(`${value} is not a valid amount.`);
  const text = String(value);
  if (!/e/i.test(text)) return text;
  // toFixed handles values in [1e-7, 1e21) without exponent notation; good enough for money.
  return value.toFixed(20).replace(/\.?0+$/, '');
}
