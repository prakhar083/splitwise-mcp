import { describe, expect, it } from 'vitest';
import { planShares, rescaleShares, sharesPayload, toSplitwiseDate } from '../src/expenses.js';
import { userCandidate } from '../src/resolve.js';
import { ALEX_KIM, ALEX_WU, ME, SAM, expense } from './fixtures.js';

const pool = [ME, ALEX_KIM, ALEX_WU, SAM].map(userCandidate);
const base = { currency: 'USD', pool, selfId: ME.id };

describe('planShares', () => {
  it('splits equally and credits the payer', () => {
    const shares = planShares({ ...base, total: 10000n, payerId: 1, split: { type: 'equal', participants: ['me', 'alex kim', 'sam'] } });
    expect(shares).toEqual([
      { userId: 1, paid: 10000n, owed: 3334n },
      { userId: 2, paid: 0n, owed: 3333n },
      { userId: 4, paid: 0n, owed: 3333n },
    ]);
  });

  it('adds a payer who is not sharing the cost', () => {
    const shares = planShares({ ...base, total: 3000n, payerId: 1, split: { type: 'equal', participants: ['alex kim', 'sam'] } });
    expect(shares).toEqual([
      { userId: 2, paid: 0n, owed: 1500n },
      { userId: 4, paid: 0n, owed: 1500n },
      { userId: 1, paid: 3000n, owed: 0n },
    ]);
  });

  it('falls back to the default participants for an equal split', () => {
    const shares = planShares({ ...base, total: 900n, payerId: 4, split: { type: 'equal' }, defaultParticipants: [1, 2, 4] });
    expect(shares.map((s) => s.owed)).toEqual([300n, 300n, 300n]);
    expect(shares.find((s) => s.userId === 4)!.paid).toBe(900n);
  });

  it('requires participants when there is no group', () => {
    expect(() => planShares({ ...base, total: 900n, payerId: 1, split: { type: 'equal' } })).toThrow(/Name the people/);
  });

  it('uses exact shares and checks they sum to the cost', () => {
    const split = { type: 'exact' as const, shares: [{ user: 'me', amount: '12.40' }, { user: 'Sam', amount: 7.6 }] };
    expect(planShares({ ...base, total: 2000n, payerId: 4, split })).toEqual([
      { userId: 1, paid: 0n, owed: 1240n },
      { userId: 4, paid: 2000n, owed: 760n },
    ]);
    expect(() => planShares({ ...base, total: 2100n, payerId: 4, split })).toThrow(/short by 1.00 USD/);
  });

  it('allocates percentages exactly', () => {
    const split = {
      type: 'percentage' as const,
      shares: [
        { user: 'me', percent: '33.3333' },
        { user: 'alex kim', percent: '33.3333' },
        { user: 'alex wu', percent: '33.3334' },
      ],
    };
    const shares = planShares({ ...base, total: 100n, payerId: 1, split });
    expect(shares.map((s) => s.owed)).toEqual([33n, 33n, 34n]);
    expect(shares.reduce((a, s) => a + s.owed, 0n)).toBe(100n);
  });

  it('propagates ambiguous names', () => {
    expect(() =>
      planShares({ ...base, total: 100n, payerId: 1, split: { type: 'equal', participants: ['me', 'alex'] } }),
    ).toThrow(/matches more than one person/);
  });
});

describe('rescaleShares', () => {
  it('keeps proportions when the cost changes', () => {
    // 90 split 30/30/30, paid by me -> 100 split 33.34/33.33/33.33.
    expect(rescaleShares(expense(), 10000n)).toEqual([
      { userId: 1, paid: 10000n, owed: 3334n },
      { userId: 2, paid: 0n, owed: 3333n },
      { userId: 4, paid: 0n, owed: 3333n },
    ]);
  });

  it('keeps unequal splits and multiple payers proportional', () => {
    const e = expense({
      cost: '100.0',
      users: [
        { user: ME, user_id: 1, paid_share: '60.0', owed_share: '25.0' },
        { user: SAM, user_id: 4, paid_share: '40.0', owed_share: '75.0' },
      ],
    });
    expect(rescaleShares(e, 2000n)).toEqual([
      { userId: 1, paid: 1200n, owed: 500n },
      { userId: 4, paid: 800n, owed: 1500n },
    ]);
  });
});

describe('sharesPayload', () => {
  it('flattens shares into users__N__ keys with currency precision', () => {
    expect(sharesPayload([{ userId: 7, paid: 1500n, owed: 500n }], 'JPY')).toEqual({
      users__0__user_id: 7,
      users__0__paid_share: '1500',
      users__0__owed_share: '500',
    });
  });
});

describe('toSplitwiseDate', () => {
  it('pins bare dates to noon UTC so they never shift a day', () => {
    expect(toSplitwiseDate('2026-03-14')).toBe('2026-03-14T12:00:00Z');
  });

  it('normalises timestamps', () => {
    expect(toSplitwiseDate('2026-03-14T08:30:00+05:30')).toBe('2026-03-14T03:00:00.000Z');
  });

  it('rejects impossible dates', () => {
    expect(() => toSplitwiseDate('2026-02-30')).toThrow(/not a valid date/);
    expect(() => toSplitwiseDate('next tuesday')).toThrow(/YYYY-MM-DD/);
  });
});
