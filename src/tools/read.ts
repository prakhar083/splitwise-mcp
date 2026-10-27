import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  presentExpense,
  presentFriend,
  presentGroup,
  presentGroupSummary,
  presentUser,
} from '../format.js';
import { formatMinor, parseApiAmount } from '../money.js';
import { normalize } from '../resolve.js';
import type { Expense, ExpenseQuery } from '../splitwise/types.js';
import { type Directory, groupRef, handle, isoDate, personRef } from './shared.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const expenseFilters = {
  group: groupRef.optional().describe('Only expenses in this group (id or name).'),
  friend: personRef.optional().describe('Only expenses shared with this friend (id or name).'),
  dated_after: isoDate.optional().describe('Only expenses dated on or after this date (YYYY-MM-DD).'),
  dated_before: isoDate.optional().describe('Only expenses dated before this date (YYYY-MM-DD).'),
};

async function buildQuery(
  dir: Directory,
  args: { group?: string | number | undefined; friend?: string | number | undefined; dated_after?: string | undefined; dated_before?: string | undefined },
): Promise<ExpenseQuery> {
  const query: ExpenseQuery = {};
  if (args.group !== undefined) query.group_id = (await dir.resolveGroup(args.group)).id;
  if (args.friend !== undefined) query.friend_id = (await dir.resolveFriend(args.friend)).id;
  if (args.dated_after) query.dated_after = args.dated_after;
  if (args.dated_before) query.dated_before = args.dated_before;
  return query;
}

export function registerReadTools(server: McpServer, dir: Directory): void {
  const { client } = dir;

  server.registerTool(
    'get_current_user',
    {
      title: 'Get current user',
      description:
        'Returns the Splitwise account this server acts as: id, name, email and default currency. ' +
        '"me" in other tools refers to this user.',
      annotations: READ_ONLY,
    },
    handle(async () => {
      const me = await dir.me();
      return { ...presentUser(me), default_currency: me.default_currency ?? null };
    }),
  );

  server.registerTool(
    'list_groups',
    {
      title: 'List groups',
      description:
        "Lists the user's Splitwise groups with member names and the user's own balance in each. " +
        'A positive balance means the group owes the user; negative means the user owes the group.',
      annotations: READ_ONLY,
    },
    handle(async () => {
      const [me, groups] = await Promise.all([dir.me(), client.getGroups()]);
      return groups.map((g) => presentGroupSummary(g, me.id));
    }),
  );

  server.registerTool(
    'get_group',
    {
      title: 'Get group',
      description:
        "Returns one group's members with their balances, plus the debts between members " +
        '(simplified if the group has debt simplification on). Accepts a group id or name.',
      inputSchema: { group: groupRef },
      annotations: READ_ONLY,
    },
    handle(async ({ group }) => presentGroup(await dir.resolveGroup(group))),
  );

  server.registerTool(
    'list_friends',
    {
      title: 'List friends',
      description:
        "Lists the user's Splitwise friends with their overall balance with the user, per currency. " +
        'A positive amount means the friend owes the user; negative means the user owes the friend.',
      annotations: READ_ONLY,
    },
    handle(async () => (await client.getFriends()).map(presentFriend)),
  );

  server.registerTool(
    'get_balances',
    {
      title: 'Get balances',
      description:
        'Summarises who owes whom. Without a group: every friend with a non-zero balance, split into ' +
        '"owes_you" and "you_owe", plus net totals per currency. With a group: the debts between group members. ' +
        'Use this before settle_up to find the amount to settle.',
      inputSchema: { group: groupRef.optional().describe('Limit to the debts inside this group (id or name).') },
      annotations: READ_ONLY,
    },
    handle(async ({ group }) => {
      if (group !== undefined) {
        const g = await dir.resolveGroup(group);
        return { group: { id: g.id, name: g.name }, debts: presentGroup(g).debts };
      }
      const friends = await client.getFriends();
      const owesYou: { friend: string; friend_id: number; amount: string; currency: string }[] = [];
      const youOwe: typeof owesYou = [];
      const totals = new Map<string, { owed_to_you: bigint; you_owe: bigint }>();
      for (const friend of friends) {
        const name = presentUser(friend).name;
        for (const balance of friend.balance ?? []) {
          const minor = parseApiAmount(balance.amount, balance.currency_code);
          if (minor === 0n) continue;
          const currency = balance.currency_code;
          const total = totals.get(currency) ?? { owed_to_you: 0n, you_owe: 0n };
          totals.set(currency, total);
          const row = { friend: name, friend_id: friend.id, amount: formatMinor(minor > 0n ? minor : -minor, currency), currency };
          if (minor > 0n) {
            owesYou.push(row);
            total.owed_to_you += minor;
          } else {
            youOwe.push(row);
            total.you_owe -= minor;
          }
        }
      }
      return {
        owes_you: owesYou,
        you_owe: youOwe,
        totals: [...totals].map(([currency, t]) => ({
          currency,
          owed_to_you: formatMinor(t.owed_to_you, currency),
          you_owe: formatMinor(t.you_owe, currency),
          net: formatMinor(t.owed_to_you - t.you_owe, currency),
        })),
      };
    }),
  );

  server.registerTool(
    'list_expenses',
    {
      title: 'List expenses',
      description:
        'Lists expenses and payments, newest first. Filter by group, friend and date range. ' +
        'Each expense shows what every person paid and owes. Deleted expenses are hidden unless include_deleted is true.',
      inputSchema: {
        ...expenseFilters,
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of expenses to return (1-100).'),
        offset: z.number().int().min(0).default(0).describe('Skip this many expenses, for paging.'),
        include_deleted: z.boolean().default(false).describe('Include expenses that were deleted.'),
      },
      annotations: READ_ONLY,
    },
    handle(async (args) => {
      const query = await buildQuery(dir, args);
      const expenses = await client.getExpenses({ ...query, limit: args.limit, offset: args.offset });
      return expenses.filter((e) => args.include_deleted || !e.deleted_at).map(presentExpense);
    }),
  );

  server.registerTool(
    'get_expense',
    {
      title: 'Get expense',
      description: 'Returns one expense or payment by id, with every person\'s paid and owed share.',
      inputSchema: { expense_id: z.number().int().positive().describe('The Splitwise expense id.') },
      annotations: READ_ONLY,
    },
    handle(async ({ expense_id }) => presentExpense(await client.getExpense(expense_id))),
  );

  server.registerTool(
    'search_expenses',
    {
      title: 'Search expenses',
      description:
        'Finds expenses whose description or notes contain every word of the query (case- and accent-insensitive), ' +
        'e.g. "pizza" or "airbnb lisbon". Splitwise has no server-side search, so this scans recent expenses ' +
        '(newest first) up to scan_limit; narrow with group, friend or dates to search further back.',
      inputSchema: {
        query: z.string().trim().min(1).describe('Words to look for in the description or notes.'),
        ...expenseFilters,
        limit: z.number().int().min(1).max(100).default(10).describe('Maximum number of matches to return.'),
        scan_limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .default(500)
          .describe('How many recent expenses to scan before giving up.'),
      },
      annotations: READ_ONLY,
    },
    handle(async (args) => {
      const query = await buildQuery(dir, args);
      const words = normalize(args.query).split(' ').filter(Boolean);
      const matches: Expense[] = [];
      const pageSize = 100;
      let scanned = 0;
      while (scanned < args.scan_limit && matches.length < args.limit) {
        const want = Math.min(pageSize, args.scan_limit - scanned);
        const page = await client.getExpenses({ ...query, limit: want, offset: scanned });
        scanned += page.length;
        for (const expense of page) {
          if (expense.deleted_at) continue;
          const haystack = normalize(`${expense.description} ${expense.details ?? ''}`);
          if (words.every((w) => haystack.includes(w))) matches.push(expense);
          if (matches.length >= args.limit) break;
        }
        if (page.length < want) break; // reached the oldest expense
      }
      return { scanned, matches: matches.map(presentExpense) };
    }),
  );
}
