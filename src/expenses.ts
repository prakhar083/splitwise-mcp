/**
 * Turns a high-level split description ("split equally between me, Alex and
 * Sam; Alex paid") into the per-user paid/owed shares Splitwise stores, and
 * then into Splitwise's flattened request payload.
 */

import {
  MoneyError,
  allocate,
  checkExactShares,
  formatMinor,
  parseAmount,
  parseApiAmount,
  splitByPercentages,
  splitEqually,
} from './money.js';
import { type Candidate, type Reference, resolveMany } from './resolve.js';
import type { Expense, ExpensePayload, User } from './splitwise/types.js';

export type SplitSpec =
  | { type: 'equal'; participants?: Reference[] | undefined }
  | { type: 'exact'; shares: { user: Reference; amount: string | number }[] }
  | { type: 'percentage'; shares: { user: Reference; percent: string | number }[] };

export interface Share {
  userId: number;
  paid: bigint;
  owed: bigint;
}

export interface PlanInput {
  total: bigint;
  currency: string;
  payerId: number;
  split: SplitSpec;
  /** People who may take part (group members, or you plus your friends). */
  pool: Candidate<User>[];
  selfId: number;
  /** Used for an equal split when no participants are named (all group members). */
  defaultParticipants?: number[] | undefined;
}

/** Computes what each participant owes. Order follows the request, which fixes who absorbs rounding. */
export function planOwed(input: Omit<PlanInput, 'payerId'>): { userId: number; owed: bigint }[] {
  const { total, currency, split, pool, selfId } = input;
  const resolveUsers = (refs: Reference[]) => resolveMany(refs, pool, { kind: 'person', selfId }).map((c) => c.id);

  switch (split.type) {
    case 'equal': {
      const ids = split.participants?.length ? resolveUsers(split.participants) : input.defaultParticipants;
      if (!ids?.length) {
        throw new MoneyError('Name the people to split between (participants), or pick a group to split among all its members.');
      }
      const amounts = splitEqually(total, ids.length);
      return ids.map((userId, i) => ({ userId, owed: amounts[i]! }));
    }
    case 'exact': {
      const ids = resolveUsers(split.shares.map((s) => s.user));
      const amounts = checkExactShares(
        total,
        split.shares.map((s) => parseAmount(s.amount, currency, { allowZero: true })),
        currency,
      );
      return ids.map((userId, i) => ({ userId, owed: amounts[i]! }));
    }
    case 'percentage': {
      const ids = resolveUsers(split.shares.map((s) => s.user));
      const amounts = splitByPercentages(
        total,
        split.shares.map((s) => s.percent),
      );
      return ids.map((userId, i) => ({ userId, owed: amounts[i]! }));
    }
  }
}

/** Merges owed and paid amounts per user, keeping first-seen order. */
export function combineShares(owed: { userId: number; owed: bigint }[], paid: { userId: number; paid: bigint }[]): Share[] {
  const byUser = new Map<number, Share>();
  const entry = (userId: number) => {
    let share = byUser.get(userId);
    if (!share) byUser.set(userId, (share = { userId, paid: 0n, owed: 0n }));
    return share;
  };
  for (const o of owed) entry(o.userId).owed += o.owed;
  for (const p of paid) entry(p.userId).paid += p.paid;
  return [...byUser.values()];
}

/** Computes every participant's owed share and credits the full cost to a single payer. */
export function planShares(input: PlanInput): Share[] {
  return combineShares(planOwed(input), [{ userId: input.payerId, paid: input.total }]);
}

/**
 * Re-scales an existing expense's shares to a new total, keeping everyone's
 * proportion of both paid and owed amounts. Used when only the cost changes.
 */
export function rescaleShares(expense: Expense, newTotal: bigint): Share[] {
  const currency = expense.currency_code;
  const paid = allocate(newTotal, expense.users.map((u) => parseApiAmount(u.paid_share, currency)));
  const owed = allocate(newTotal, expense.users.map((u) => parseApiAmount(u.owed_share, currency)));
  return expense.users.map((u, i) => ({ userId: u.user_id, paid: paid[i]!, owed: owed[i]! }));
}

/** Flattens shares into Splitwise's users__N__field keys. */
export function sharesPayload(shares: Share[], currency: string): ExpensePayload {
  const payload: ExpensePayload = {};
  shares.forEach((share, i) => {
    payload[`users__${i}__user_id`] = share.userId;
    payload[`users__${i}__paid_share`] = formatMinor(share.paid, currency);
    payload[`users__${i}__owed_share`] = formatMinor(share.owed, currency);
  });
  return payload;
}

/**
 * Splitwise stores a datetime. A bare date is sent as noon UTC so it shows up
 * on the same calendar day in every timezone.
 */
export function toSplitwiseDate(date: string): string {
  const trimmed = date.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const noon = `${trimmed}T12:00:00Z`;
    const parsed = Date.parse(noon);
    // Date.parse rolls 2026-02-30 over to March; reject it instead.
    if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== trimmed) {
      throw new Error(`"${date}" is not a valid date.`);
    }
    return noon;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) throw new Error(`"${date}" is not a valid date. Use YYYY-MM-DD or an ISO 8601 timestamp.`);
  return new Date(parsed).toISOString();
}
