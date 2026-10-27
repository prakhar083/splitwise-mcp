/**
 * Compact, model-friendly views of Splitwise objects. The raw API payloads are
 * large (avatars, notification settings, category trees); tools return only
 * what is useful for reasoning about money, with amounts normalised to the
 * currency's precision.
 */

import { formatMinor, parseApiAmount } from './money.js';
import { fullName } from './resolve.js';
import type { Balance, Debt, Expense, Friend, Group, User } from './splitwise/types.js';

export function presentUser(user: User) {
  return {
    id: user.id,
    name: fullName(user) || user.email || `User ${user.id}`,
    ...(user.email ? { email: user.email } : {}),
  };
}

export function normalizeAmount(amount: string | number | null | undefined, currency: string): string {
  return formatMinor(parseApiAmount(amount, currency), currency);
}

/** Non-zero balances only; Splitwise lists zero entries for every currency ever used. */
export function presentBalances(balances: Balance[] | undefined) {
  return (balances ?? [])
    .map((b) => ({ currency: b.currency_code, minor: parseApiAmount(b.amount, b.currency_code) }))
    .filter((b) => b.minor !== 0n)
    .map((b) => ({ currency: b.currency, amount: formatMinor(b.minor, b.currency) }));
}

export function nameLookup(users: User[]): (id: number) => string {
  const names = new Map(users.map((u) => [u.id, presentUser(u).name]));
  return (id) => names.get(id) ?? `User ${id}`;
}

export function presentDebts(debts: Debt[] | undefined, nameOf: (id: number) => string) {
  return (debts ?? [])
    .map((d) => ({ d, minor: parseApiAmount(d.amount, d.currency_code) }))
    .filter(({ minor }) => minor !== 0n)
    .map(({ d, minor }) => ({
      from: { id: d.from, name: nameOf(d.from) },
      to: { id: d.to, name: nameOf(d.to) },
      amount: formatMinor(minor, d.currency_code),
      currency: d.currency_code,
      summary: `${nameOf(d.from)} owes ${nameOf(d.to)} ${formatMinor(minor, d.currency_code)} ${d.currency_code}`,
    }));
}

export function presentGroupSummary(group: Group, selfId: number) {
  const me = group.members.find((m) => m.id === selfId);
  return {
    id: group.id,
    name: group.id === 0 ? 'Non-group expenses' : group.name,
    members: group.members.map((m) => presentUser(m).name),
    your_balance: presentBalances(me?.balance),
  };
}

export function presentGroup(group: Group) {
  const nameOf = nameLookup(group.members);
  const debts = group.simplify_by_default === false ? group.original_debts : (group.simplified_debts ?? group.original_debts);
  return {
    id: group.id,
    name: group.name,
    ...(group.group_type ? { type: group.group_type } : {}),
    members: group.members.map((m) => ({ ...presentUser(m), balance: presentBalances(m.balance) })),
    debts: presentDebts(debts, nameOf),
  };
}

export function presentFriend(friend: Friend) {
  return { ...presentUser(friend), balance: presentBalances(friend.balance) };
}

export function presentExpense(expense: Expense) {
  const currency = expense.currency_code;
  return {
    id: expense.id,
    description: expense.description,
    cost: normalizeAmount(expense.cost, currency),
    currency,
    date: expense.date,
    group_id: expense.group_id || null,
    ...(expense.payment ? { payment: true } : {}),
    ...(expense.details ? { details: expense.details } : {}),
    ...(expense.category?.name && expense.category.name !== 'General' ? { category: expense.category.name } : {}),
    ...(expense.created_by ? { created_by: presentUser(expense.created_by).name } : {}),
    ...(expense.deleted_at ? { deleted_at: expense.deleted_at } : {}),
    shares: expense.users.map((share) => ({
      user_id: share.user_id,
      name: share.user ? presentUser(share.user).name : `User ${share.user_id}`,
      paid: normalizeAmount(share.paid_share, currency),
      owed: normalizeAmount(share.owed_share, currency),
    })),
  };
}
