/**
 * An in-memory stand-in for the Splitwise API, served through a mocked fetch.
 * All people and groups are fictional.
 */
import { vi } from 'vitest';
import type { Expense, Friend, Group, User } from '../src/splitwise/types.js';

export const ME: User = { id: 1, first_name: 'Riya', last_name: 'Sharma', email: 'riya@example.com', default_currency: 'USD' };
export const ALEX_KIM: User = { id: 2, first_name: 'Alex', last_name: 'Kim', email: 'alex.kim@example.com' };
export const ALEX_WU: User = { id: 3, first_name: 'Alex', last_name: 'Wu', email: 'awu@example.com' };
export const SAM: User = { id: 4, first_name: 'Sam', last_name: 'Patel', email: 'sam@example.com' };
export const JONATHAN: User = { id: 5, first_name: 'Jonathan', last_name: 'Reed', email: null };
export const ZOE: User = { id: 6, first_name: 'Zoë', last_name: 'Müller', email: 'zoe@example.com' };

export function friends(): Friend[] {
  return [
    { ...ALEX_KIM, balance: [{ currency_code: 'USD', amount: '42.5' }] },
    { ...ALEX_WU, balance: [{ currency_code: 'USD', amount: '-12.25' }, { currency_code: 'EUR', amount: '0.0' }] },
    { ...SAM, balance: [{ currency_code: 'USD', amount: '10.00' }, { currency_code: 'EUR', amount: '7.5' }] },
    { ...JONATHAN, balance: [] },
    { ...ZOE, balance: [{ currency_code: 'JPY', amount: '-1500' }] },
  ];
}

export function groups(): Group[] {
  return [
    {
      id: 0,
      name: 'Non-group expenses',
      members: [],
      simplified_debts: [],
      original_debts: [],
    },
    {
      id: 100,
      name: 'Lisbon Trip',
      group_type: 'trip',
      simplify_by_default: true,
      members: [
        { ...ME, balance: [{ currency_code: 'USD', amount: '30.0' }] },
        { ...ALEX_KIM, balance: [{ currency_code: 'USD', amount: '-20.0' }] },
        { ...SAM, balance: [{ currency_code: 'USD', amount: '-10.0' }] },
      ],
      simplified_debts: [
        { from: 2, to: 1, amount: '20.0', currency_code: 'USD' },
        { from: 4, to: 1, amount: '10.0', currency_code: 'USD' },
      ],
      original_debts: [],
    },
    {
      id: 200,
      name: 'Flat 4B',
      group_type: 'apartment',
      simplify_by_default: false,
      members: [
        { ...ME, balance: [{ currency_code: 'USD', amount: '-12.25' }] },
        { ...ALEX_WU, balance: [{ currency_code: 'USD', amount: '12.25' }] },
        { ...JONATHAN, balance: [] },
      ],
      simplified_debts: [],
      original_debts: [{ from: 1, to: 3, amount: '12.25', currency_code: 'USD' }],
    },
  ];
}

export function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 9001,
    group_id: 100,
    description: 'Dinner at Taberna',
    details: null,
    payment: false,
    cost: '90.0',
    currency_code: 'USD',
    date: '2026-05-02T19:00:00Z',
    deleted_at: null,
    created_by: ME,
    users: [
      { user: ME, user_id: 1, paid_share: '90.0', owed_share: '30.0' },
      { user: ALEX_KIM, user_id: 2, paid_share: '0.0', owed_share: '30.0' },
      { user: SAM, user_id: 4, paid_share: '0.0', owed_share: '30.0' },
    ],
    ...overrides,
  };
}

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
  headers: Headers;
}

/**
 * A fetch implementation backed by fixtures. Write endpoints echo back an
 * expense built from the request payload, the way Splitwise does.
 */
export function fakeSplitwise(options: { expenses?: Expense[] } = {}) {
  const calls: RecordedCall[] = [];
  const expenses = options.expenses ?? [
    expense(),
    expense({ id: 9002, description: 'Pastéis de nata', cost: '12.0', date: '2026-05-01T09:00:00Z' }),
    expense({ id: 9003, description: 'Airbnb Lisbon', cost: '600.0', details: 'Alfama flat, 3 nights' }),
    expense({ id: 9004, description: 'Old taxi', deleted_at: '2026-05-03T00:00:00Z' }),
  ];

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  function echoExpense(id: number, body: Record<string, unknown>): Expense {
    const users = [];
    for (let i = 0; body[`users__${i}__user_id`] !== undefined; i++) {
      const userId = Number(body[`users__${i}__user_id`]);
      users.push({
        user: [ME, ALEX_KIM, ALEX_WU, SAM, JONATHAN, ZOE].find((u) => u.id === userId) ?? null,
        user_id: userId,
        paid_share: String(body[`users__${i}__paid_share`]),
        owed_share: String(body[`users__${i}__owed_share`]),
      });
    }
    const base = expenses.find((e) => e.id === id) ?? expense({ id });
    return {
      ...base,
      description: (body.description as string) ?? base.description,
      cost: (body.cost as string) ?? base.cost,
      currency_code: (body.currency_code as string) ?? base.currency_code,
      group_id: body.group_id === undefined ? base.group_id : (body.group_id as number) || null,
      payment: Boolean(body.payment ?? base.payment),
      details: (body.details as string) ?? base.details,
      date: (body.date as string) ?? base.date,
      users: users.length > 0 ? users : base.users,
    };
  }

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v3\.0/, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, query: Object.fromEntries(url.searchParams), body, headers: new Headers(init?.headers) });

    let match: RegExpExecArray | null;
    if (path === '/get_current_user') return json(200, { user: ME });
    if (path === '/get_groups') return json(200, { groups: groups() });
    if ((match = /^\/get_group\/(\d+)$/.exec(path))) {
      const group = groups().find((g) => g.id === Number(match![1]));
      return group ? json(200, { group }) : json(404, { errors: { base: ['Invalid group'] } });
    }
    if (path === '/get_friends') return json(200, { friends: friends() });
    if (path === '/get_expenses') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const groupId = url.searchParams.get('group_id');
      const filtered = expenses.filter((e) => !groupId || e.group_id === Number(groupId));
      return json(200, { expenses: filtered.slice(offset, offset + limit) });
    }
    if ((match = /^\/get_expense\/(\d+)$/.exec(path))) {
      const found = expenses.find((e) => e.id === Number(match![1]));
      return found ? json(200, { expense: found }) : json(404, { errors: { base: ['Invalid expense'] } });
    }
    if (path === '/create_expense') return json(200, { expenses: [echoExpense(9999, body ?? {})], errors: {} });
    if ((match = /^\/update_expense\/(\d+)$/.exec(path))) {
      return json(200, { expenses: [echoExpense(Number(match[1]), body ?? {})], errors: {} });
    }
    if ((match = /^\/delete_expense\/(\d+)$/.exec(path))) return json(200, { success: true, errors: {} });
    return json(404, { error: `No route for ${path}` });
  });

  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, mock: fetch };
}
