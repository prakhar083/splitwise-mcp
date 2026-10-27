import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  allocate,
  checkExactShares,
  currencyExponent,
  formatMinor,
  normalizeCurrency,
  parseAmount,
  parseApiAmount,
  parsePercent,
  splitByPercentages,
  splitEqually,
} from '../src/money.js';

/** Small deterministic PRNG (mulberry32) so property-style tests are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe('currencies', () => {
  it('normalises case and whitespace', () => {
    expect(normalizeCurrency(' usd ')).toBe('USD');
  });

  it.each(['US', 'USDT', '12A', '', 'dollars'])('rejects malformed code %j', (code) => {
    expect(() => normalizeCurrency(code)).toThrow(/currency code/);
  });

  it('rejects well-formed but unknown codes', () => {
    expect(() => normalizeCurrency('ZZZ')).toThrow(/Unknown currency code "ZZZ"/);
  });

  it('knows each currency precision', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('INR')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KRW')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('BHD')).toBe(3);
  });
});

describe('parseAmount', () => {
  it.each([
    ['12.34', 'USD', 1234n],
    ['12.3', 'USD', 1230n],
    ['12', 'USD', 1200n],
    ['.5', 'USD', 50n],
    ['0.01', 'USD', 1n],
    ['1,234.50', 'USD', 123450n],
    ['12.30', 'USD', 1230n],
    ['12.000', 'USD', 1200n],
    ['1500', 'JPY', 1500n],
    ['1.500', 'KWD', 1500n],
    ['1.234', 'KWD', 1234n],
  ])('parses %s %s as %s minor units', (input, currency, expected) => {
    expect(parseAmount(input, currency)).toBe(expected);
  });

  it('parses numbers without float drift', () => {
    expect(parseAmount(0.1 + 0.2 - 0.00000000000000004, 'USD')).toBe(30n);
    expect(parseAmount(19.99, 'USD')).toBe(1999n);
    expect(parseAmount(1e6, 'USD')).toBe(100000000n);
  });

  it('refuses to silently round extra precision', () => {
    expect(() => parseAmount('10.005', 'USD')).toThrow(/more decimal places than USD allows \(2\)/);
    expect(() => parseAmount('100.5', 'JPY')).toThrow(/JPY allows \(0\)/);
    expect(() => parseAmount(0.30000000000000004, 'USD')).toThrow(MoneyError);
  });

  it.each(['-5', '0', '0.00', 'abc', '1.2.3', '', '.', '1e3', 'NaN'])('rejects %j', (input) => {
    expect(() => parseAmount(input, 'USD')).toThrow(MoneyError);
  });

  it('only strips unambiguous thousands separators', () => {
    expect(parseAmount('12,345,678.90', 'USD')).toBe(1234567890n);
    expect(() => parseAmount('1,5', 'USD')).toThrow(/ambiguous/);
    expect(() => parseAmount('12,34.00', 'USD')).toThrow(/ambiguous/);
  });

  it('allows zero only when asked', () => {
    expect(parseAmount('0', 'USD', { allowZero: true })).toBe(0n);
  });

  it('handles amounts far beyond Number.MAX_SAFE_INTEGER', () => {
    expect(parseAmount('123456789012345678.99', 'USD')).toBe(12345678901234567899n);
  });
});

describe('parseApiAmount / formatMinor', () => {
  it('reads Splitwise strings, including negatives and short decimals', () => {
    expect(parseApiAmount('12.5', 'USD')).toBe(1250n);
    expect(parseApiAmount('-4.33', 'USD')).toBe(-433n);
    expect(parseApiAmount('0.0', 'USD')).toBe(0n);
    expect(parseApiAmount(null, 'USD')).toBe(0n);
    expect(parseApiAmount('7', 'JPY')).toBe(7n);
  });

  it('rounds extra precision half away from zero', () => {
    expect(parseApiAmount('1.005', 'USD')).toBe(101n);
    expect(parseApiAmount('-1.005', 'USD')).toBe(-101n);
    expect(parseApiAmount('1.004', 'USD')).toBe(100n);
  });

  it('falls back to two decimals for codes outside ICU', () => {
    expect(parseApiAmount('3.21', 'XYZ1')).toBe(321n);
  });

  it.each([
    [1234n, 'USD', '12.34'],
    [5n, 'USD', '0.05'],
    [0n, 'USD', '0.00'],
    [-433n, 'USD', '-4.33'],
    [1500n, 'JPY', '1500'],
    [1500n, 'KWD', '1.500'],
  ])('formats %s %s as %s', (minor, currency, expected) => {
    expect(formatMinor(minor, currency)).toBe(expected);
  });

  it('round-trips random amounts', () => {
    const random = rng(7);
    for (let i = 0; i < 500; i++) {
      const minor = BigInt(Math.floor(random() * 1e12)) + 1n;
      for (const currency of ['USD', 'JPY', 'KWD']) {
        expect(parseAmount(formatMinor(minor, currency), currency)).toBe(minor);
      }
    }
  });
});

describe('splitEqually', () => {
  it('gives leftover cents to the first people, in order', () => {
    expect(splitEqually(1000n, 3)).toEqual([334n, 333n, 333n]);
    expect(splitEqually(1001n, 3)).toEqual([334n, 334n, 333n]);
    expect(splitEqually(999n, 3)).toEqual([333n, 333n, 333n]);
  });

  it('handles fewer cents than people', () => {
    expect(splitEqually(2n, 5)).toEqual([1n, 1n, 0n, 0n, 0n]);
  });

  it('handles a single person', () => {
    expect(splitEqually(4321n, 1)).toEqual([4321n]);
  });

  it('rejects an empty split', () => {
    expect(() => splitEqually(100n, 0)).toThrow(/zero people/);
  });

  it('property: shares sum to the total, differ by at most one unit, and are non-increasing', () => {
    const random = rng(42);
    for (let i = 0; i < 2000; i++) {
      const total = BigInt(Math.floor(random() * 10_000_000)) + 1n;
      const n = 1 + Math.floor(random() * 25);
      const shares = splitEqually(total, n);
      expect(shares).toHaveLength(n);
      expect(sum(shares)).toBe(total);
      const max = shares.reduce((a, b) => (a > b ? a : b));
      const min = shares.reduce((a, b) => (a < b ? a : b));
      expect(max - min <= 1n).toBe(true);
      for (let j = 1; j < n; j++) expect(shares[j]! <= shares[j - 1]!).toBe(true);
      expect(splitEqually(total, n)).toEqual(shares); // deterministic
    }
  });
});

describe('allocate', () => {
  it('distributes by weight with largest remainders', () => {
    // 100 split 1:1:1 -> 33.33.. each, one leftover to the first.
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    // 10 split 2:1 -> 6.67 / 3.33: the leftover unit goes to the larger remainder.
    expect(allocate(10n, [2n, 1n])).toEqual([7n, 3n]);
    // Zero weights get nothing.
    expect(allocate(500n, [0n, 1n, 0n, 1n])).toEqual([0n, 250n, 0n, 250n]);
  });

  it('breaks ties by position', () => {
    expect(allocate(1n, [1n, 1n])).toEqual([1n, 0n]);
    expect(allocate(1n, [3n, 3n, 3n])).toEqual([1n, 0n, 0n]);
  });

  it('rejects invalid weights', () => {
    expect(() => allocate(100n, [])).toThrow(MoneyError);
    expect(() => allocate(100n, [0n, 0n])).toThrow(/all be zero/);
    expect(() => allocate(100n, [1n, -1n])).toThrow(/negative/);
    expect(() => allocate(-1n, [1n])).toThrow(/negative/);
  });

  it('property: sums exactly and every share is within one unit of its exact proportion', () => {
    const random = rng(1234);
    for (let i = 0; i < 2000; i++) {
      const total = BigInt(Math.floor(random() * 1e9));
      const weights = Array.from({ length: 1 + Math.floor(random() * 12) }, () => BigInt(Math.floor(random() * 1000)));
      if (sum(weights) === 0n) weights[0] = 1n;
      const shares = allocate(total, weights);
      expect(sum(shares)).toBe(total);
      const weightSum = sum(weights);
      shares.forEach((share, j) => {
        const floor = (total * weights[j]!) / weightSum;
        expect(share === floor || share === floor + 1n).toBe(true);
      });
    }
  });

  it('is exact for totals beyond float precision', () => {
    const total = 90071992547409930n; // 10 x MAX_SAFE_INTEGER
    const shares = allocate(total, [1n, 1n, 1n]);
    expect(sum(shares)).toBe(total);
    expect(shares).toEqual([30023997515803310n, 30023997515803310n, 30023997515803310n]);
  });
});

describe('splitByPercentages', () => {
  it('never loses or invents a cent', () => {
    expect(splitByPercentages(10000n, ['33.3333', '33.3333', '33.3334'])).toEqual([3333n, 3333n, 3334n]);
    expect(splitByPercentages(100n, [50, 50])).toEqual([50n, 50n]);
    expect(splitByPercentages(1n, [50, 50])).toEqual([1n, 0n]);
    expect(splitByPercentages(999n, [60, 40])).toEqual([599n, 400n]);
  });

  it('accepts a trailing percent sign', () => {
    expect(parsePercent('12.5%')).toBe(125000n);
  });

  it('requires percentages to total exactly 100', () => {
    expect(() => splitByPercentages(100n, [33, 33, 33])).toThrow(/add up to 99/);
    expect(() => splitByPercentages(100n, [60, 50])).toThrow(/add up to 110/);
    expect(() => splitByPercentages(100n, ['33.33', '33.33', '33.33'])).toThrow(/add up to 99.99/);
  });

  it('rejects negative or overly precise percentages', () => {
    expect(() => splitByPercentages(100n, [-10, 110])).toThrow(/negative/);
    expect(() => splitByPercentages(100n, ['33.33333', '66.66667'])).toThrow(/at most 4 decimal places/);
  });

  it('property: random percentages that total 100 always sum to the cost', () => {
    const random = rng(99);
    for (let i = 0; i < 1000; i++) {
      const n = 1 + Math.floor(random() * 8);
      // Build basis points that sum to 10000, then express as percentages with 2 decimals.
      const cuts = Array.from({ length: n - 1 }, () => Math.floor(random() * 10001)).sort((a, b) => a - b);
      const bps = [...cuts, 10000].map((c, j) => c - (j === 0 ? 0 : [...cuts, 10000][j - 1]!));
      const percents = bps.map((b) => (b / 100).toFixed(2));
      const total = BigInt(Math.floor(random() * 1_000_000)) + 1n;
      const shares = splitByPercentages(total, percents);
      expect(sum(shares)).toBe(total);
    }
  });
});

describe('checkExactShares', () => {
  it('accepts shares that sum to the total', () => {
    expect(checkExactShares(1000n, [250n, 750n], 'USD')).toEqual([250n, 750n]);
  });

  it('reports exactly how far off the shares are', () => {
    expect(() => checkExactShares(1000n, [250n, 700n], 'USD')).toThrow(
      'Shares add up to 9.50 but the cost is 10.00 (short by 0.50 USD).',
    );
    expect(() => checkExactShares(1000n, [250n, 751n], 'USD')).toThrow(/over by 0.01 USD/);
  });
});
