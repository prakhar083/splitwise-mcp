import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type Share, type SplitSpec, combineShares, planOwed, planShares, rescaleShares, sharesPayload, toSplitwiseDate } from '../expenses.js';
import { presentExpense, presentGroup, presentUser } from '../format.js';
import { MoneyError, formatMinor, normalizeCurrency, parseAmount, parseApiAmount } from '../money.js';
import { resolveOne } from '../resolve.js';
import type { Expense, ExpensePayload, Group, User } from '../splitwise/types.js';
import { type Directory, amount, currencyCode, groupRef, handle, isoDate, personRef } from './shared.js';

const split = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('equal'),
      participants: z
        .array(personRef)
        .min(1)
        .optional()
        .describe('People sharing the cost equally, payer included if they share it. Omit to use every group member.'),
    }),
    z.object({
      type: z.literal('exact'),
      shares: z
        .array(z.object({ user: personRef, amount: z
            .union([z.string().trim().min(1), z.number().nonnegative()])
            .describe('What this person owes, e.g. "12.40". May be 0.'), }))
        .min(1)
        .describe('What each person owes. Must add up exactly to the cost.'),
    }),
    z.object({
      type: z.literal('percentage'),
      shares: z
        .array(
          z.object({
            user: personRef,
            percent: z.union([z.string().trim().min(1), z.number().nonnegative()]).describe('e.g. 40 or "33.3333"'),
          }),
        )
        .min(1)
        .describe('Percentage each person owes. Must add up to exactly 100.'),
    }),
  ]);

const SPLIT_DOC =
  'How to divide the cost. "equal": among participants; leftover cents go to the first participants listed. ' +
  '"exact": explicit amounts per person. "percentage": percent per person; rounding goes to the largest remainders.';

/** The currency to use: the one given, else the account default. */
function pickCurrency(given: string | undefined, me: User): string {
  const code = given ?? me.default_currency;
  if (!code) throw new MoneyError('Pass currency_code: the Splitwise account has no default currency.');
  return normalizeCurrency(code);
}

export function registerWriteTools(server: McpServer, dir: Directory): void {
  const { client } = dir;

  server.registerTool(
    'create_expense',
    {
      title: 'Create expense',
      description:
        'Adds an expense to Splitwise. Choose a group (or omit it for an expense between you and friends), who paid ' +
        '(default: you), and how to split: equally, by exact amounts, or by percentages. People can be given by ' +
        'name or id. Amounts are computed in whole cents, so the shares always add up exactly to the cost. ' +
        'If a name is ambiguous the tool returns the candidates instead of guessing: ask the user which one.',
      inputSchema: {
        description: z.string().trim().min(1).max(255).describe('What the expense was for, e.g. "Dinner at Nopa".'),
        cost: amount.describe('Total cost, e.g. "86.40".'),
        currency_code: currencyCode.optional().describe("ISO 4217 code. Defaults to the user's default currency."),
        group: groupRef.optional().describe('Group to add the expense to. Omit for a non-group expense with friends.'),
        paid_by: personRef.optional().describe('Who paid the whole cost. Defaults to "me".'),
        split: split.default({ type: 'equal' }).describe(`${SPLIT_DOC} Defaults to an equal split among all group members.`),
        date: isoDate.optional().describe('When it happened. Defaults to now.'),
        notes: z.string().max(5000).optional().describe('Optional longer notes, stored as the expense details.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handle(async (args) => {
      const me = await dir.me();
      const currency = pickCurrency(args.currency_code, me);
      const total = parseAmount(args.cost, currency);
      const group: Group | undefined = args.group !== undefined ? await dir.resolveGroup(args.group) : undefined;
      const pool = await dir.people(group);
      const payer = resolveOne(args.paid_by ?? 'me', pool, { kind: 'person', selfId: me.id });

      const shares = planShares({
        total,
        currency,
        payerId: payer.id,
        split: args.split as SplitSpec,
        pool,
        selfId: me.id,
        defaultParticipants: group?.members.map((m) => m.id),
      });

      const payload: ExpensePayload = {
        cost: formatMinor(total, currency),
        currency_code: currency,
        description: args.description,
        group_id: group?.id ?? 0,
        ...(args.date ? { date: toSplitwiseDate(args.date) } : {}),
        ...(args.notes ? { details: args.notes } : {}),
        ...sharesPayload(shares, currency),
      };
      const expense = await client.createExpense(payload);
      return { created: presentExpense(expense) };
    }),
  );

  server.registerTool(
    'update_expense',
    {
      title: 'Update expense',
      description:
        'Edits an existing expense. Only the fields you pass change. Changing the cost alone rescales everyone\'s ' +
        'shares proportionally; pass split to redistribute, or paid_by to change who paid. Read the expense with ' +
        'get_expense first so you can confirm the change with the user.',
      inputSchema: {
        expense_id: z.number().int().positive().describe('The Splitwise expense id.'),
        description: z.string().trim().min(1).max(255).optional(),
        cost: amount.optional().describe('New total cost.'),
        currency_code: currencyCode.optional(),
        paid_by: personRef.optional().describe('Who paid the whole cost.'),
        split: split.optional().describe(`${SPLIT_DOC} Omit to keep the current proportions.`),
        date: isoDate.optional(),
        notes: z.string().max(5000).optional().describe('Replaces the expense notes.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handle(async (args) => {
      const existing = await client.getExpense(args.expense_id);
      if (existing.deleted_at) throw new Error(`Expense ${existing.id} is deleted; restore it in Splitwise before editing.`);

      const payload: ExpensePayload = {};
      if (args.description !== undefined) payload.description = args.description;
      if (args.date !== undefined) payload.date = toSplitwiseDate(args.date);
      if (args.notes !== undefined) payload.details = args.notes;

      const moneyChanged =
        args.cost !== undefined || args.currency_code !== undefined || args.split !== undefined || args.paid_by !== undefined;
      let shares: Share[] | undefined;
      let currency = existing.currency_code;
      if (moneyChanged) {
        currency = normalizeCurrency(args.currency_code ?? existing.currency_code);
        const total = parseAmount(args.cost ?? normalizeAmountFor(existing), currency);
        shares = await replanShares(dir, existing, { ...args, split: args.split as SplitSpec | undefined }, total, currency);
        Object.assign(payload, { cost: formatMinor(total, currency), currency_code: currency }, sharesPayload(shares, currency));
      }
      if (Object.keys(payload).length === 0) throw new Error('Nothing to update: pass at least one field to change.');

      const expense = await client.updateExpense(existing.id, payload);
      return { updated: presentExpense(expense) };
    }),
  );

  server.registerTool(
    'delete_expense',
    {
      title: 'Delete expense',
      description:
        'Deletes an expense or payment. Balances change immediately. Confirm with the user before calling; ' +
        'Splitwise can restore it from the web app if needed.',
      inputSchema: { expense_id: z.number().int().positive().describe('The Splitwise expense id.') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    handle(async ({ expense_id }) => {
      const expense = await client.getExpense(expense_id);
      if (expense.deleted_at) return { deleted: presentExpense(expense), note: 'Already deleted.' };
      await client.deleteExpense(expense_id);
      return { deleted: presentExpense(expense) };
    }),
  );

  server.registerTool(
    'settle_up',
    {
      title: 'Settle up',
      description:
        'Records a payment from one person to another (e.g. "Alex paid me back"). This does not move money; it ' +
        'records that money changed hands. Omit amount to settle the full outstanding balance: within the group if ' +
        'one is given, otherwise the overall balance between you and a friend.',
      inputSchema: {
        from: personRef.describe('Who paid (the person who owed money).'),
        to: personRef.describe('Who received the money.'),
        amount: amount.optional().describe('Amount paid. Omit to settle the whole outstanding balance.'),
        currency_code: currencyCode.optional().describe('Required if the balance spans several currencies.'),
        group: groupRef.optional().describe('Record the payment in this group.'),
        date: isoDate.optional(),
        notes: z.string().max(5000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handle(async (args) => {
      const me = await dir.me();
      const group = args.group !== undefined ? await dir.resolveGroup(args.group) : undefined;
      const pool = await dir.people(group);
      const from = resolveOne(args.from, pool, { kind: 'person', selfId: me.id }).value;
      const to = resolveOne(args.to, pool, { kind: 'person', selfId: me.id }).value;
      if (from.id === to.id) throw new Error('"from" and "to" are the same person.');

      let currency: string;
      let total: bigint;
      if (args.amount !== undefined) {
        currency = pickCurrency(args.currency_code, me);
        total = parseAmount(args.amount, currency);
      } else {
        ({ currency, total } = await outstanding(dir, me, from, to, group, args.currency_code));
      }

      const expense = await client.createExpense({
        payment: true,
        cost: formatMinor(total, currency),
        currency_code: currency,
        description: 'Payment',
        group_id: group?.id ?? 0,
        ...(args.date ? { date: toSplitwiseDate(args.date) } : {}),
        ...(args.notes ? { details: args.notes } : {}),
        ...sharesPayload(
          [
            { userId: from.id, paid: total, owed: 0n },
            { userId: to.id, paid: 0n, owed: total },
          ],
          currency,
        ),
      });
      return {
        recorded: `${presentUser(from).name} paid ${presentUser(to).name} ${formatMinor(total, currency)} ${currency}`,
        payment: presentExpense(expense),
      };
    }),
  );
}

function normalizeAmountFor(expense: Expense): string {
  return formatMinor(parseApiAmount(expense.cost, expense.currency_code), expense.currency_code);
}

/**
 * New shares for an edited expense. Owed amounts come from the new split, or
 * the old ones rescaled to the new total; paid amounts go to the new payer, or
 * the old payers rescaled.
 */
async function replanShares(
  dir: Directory,
  existing: Expense,
  args: { split?: SplitSpec | undefined; paid_by?: string | number | undefined },
  total: bigint,
  currency: string,
): Promise<Share[]> {
  const me = await dir.me();
  const group = existing.group_id ? await dir.resolveGroup(existing.group_id) : undefined;
  const pool = await dir.people(group, existing.users.flatMap((u) => (u.user ? [u.user] : [])));
  const rescaled = rescaleShares(existing, total);

  const owed = args.split
    ? planOwed({
        total,
        currency,
        split: args.split,
        pool,
        selfId: me.id,
        defaultParticipants: group?.members.map((m) => m.id) ?? existing.users.map((u) => u.user_id),
      })
    : rescaled.map(({ userId, owed }) => ({ userId, owed }));
  const paid =
    args.paid_by !== undefined
      ? [{ userId: resolveOne(args.paid_by, pool, { kind: 'person', selfId: me.id }).id, paid: total }]
      : rescaled.map(({ userId, paid }) => ({ userId, paid }));
  return combineShares(owed, paid);
}

/** The full balance `from` owes `to`, in a single currency. */
async function outstanding(
  dir: Directory,
  me: User,
  from: User,
  to: User,
  group: Group | undefined,
  currencyHint: string | undefined,
): Promise<{ currency: string; total: bigint }> {
  const wanted = currencyHint ? normalizeCurrency(currencyHint) : undefined;
  const fromName = presentUser(from).name;
  const toName = presentUser(to).name;

  let candidates: { currency: string; minor: bigint }[];
  if (group) {
    const debts = presentGroup(group).debts;
    const owed = debts.filter((d) => d.from.id === from.id && d.to.id === to.id);
    if (owed.length === 0) {
      const reverse = debts.find((d) => d.from.id === to.id && d.to.id === from.id);
      throw new MoneyError(
        reverse
          ? `${fromName} does not owe ${toName} in ${group.name}; ${reverse.summary}. Swap from and to, or pass an amount.`
          : `${fromName} does not owe ${toName} anything in ${group.name}. Pass an amount to record a payment anyway.`,
      );
    }
    candidates = owed.map((d) => ({ currency: d.currency, minor: parseApiAmount(d.amount, d.currency) }));
  } else {
    if (from.id !== me.id && to.id !== me.id) {
      throw new MoneyError('Without a group, the full balance is only known between you and a friend. Pass an amount or a group.');
    }
    const friendId = from.id === me.id ? to.id : from.id;
    const friend = (await dir.client.getFriends()).find((f) => f.id === friendId);
    // A friend's balance is positive when they owe you.
    const sign = from.id === me.id ? -1n : 1n;
    const balances = (friend?.balance ?? []).map((b) => ({
      currency: b.currency_code,
      minor: parseApiAmount(b.amount, b.currency_code) * sign,
    }));
    candidates = balances.filter((b) => b.minor > 0n);
    if (candidates.length === 0) {
      const reverse = balances.find((b) => b.minor < 0n);
      throw new MoneyError(
        reverse
          ? `${fromName} does not owe ${toName}; it is the other way round (${formatMinor(-reverse.minor, reverse.currency)} ${reverse.currency}). Swap from and to, or pass an amount.`
          : `${fromName} and ${toName} are already settled up.`,
      );
    }
  }

  const matching = wanted ? candidates.filter((c) => c.currency === wanted) : candidates;
  if (matching.length === 0) throw new MoneyError(`${fromName} owes ${toName} nothing in ${wanted}.`);
  if (matching.length > 1) {
    const list = matching.map((c) => `${formatMinor(c.minor, c.currency)} ${c.currency}`).join(', ');
    throw new MoneyError(`${fromName} owes ${toName} in several currencies (${list}). Pass currency_code to pick one.`);
  }
  const { currency, minor } = matching[0]!;
  return { currency, total: minor };
}
