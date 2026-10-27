import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { READ_TOOLS, WRITE_TOOLS, createServer } from '../src/server.js';
import { expense, fakeSplitwise } from './fixtures.js';

const open: Client[] = [];

async function connect(options: { readOnly?: boolean; fake?: ReturnType<typeof fakeSplitwise> } = {}) {
  const fake = options.fake ?? fakeSplitwise();
  const server = createServer({ client: { apiKey: 'test-key', fetch: fake.fetch }, readOnly: options.readOnly ?? false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  open.push(client);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    return { isError: result.isError ?? false, text, json: () => JSON.parse(text) };
  };
  const writes = () => fake.calls.filter((c) => c.method === 'POST');
  return { client, call, fake, writes };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

describe('tool registration', () => {
  it('lists every tool with a description', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    for (const tool of tools) expect(tool.description!.length).toBeGreaterThan(40);
  });

  it('annotates read and write tools', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const name of READ_TOOLS) expect(byName[name]?.readOnlyHint).toBe(true);
    expect(byName.delete_expense).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(byName.update_expense).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(byName.create_expense).toMatchObject({ destructiveHint: false, idempotentHint: false });
    expect(byName.settle_up).toMatchObject({ destructiveHint: false, idempotentHint: false });
  });

  it('does not register mutating tools in read-only mode', async () => {
    const { client } = await connect({ readOnly: true });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    expect(client.getInstructions()).toMatch(/read-only mode/);
  });

  it('rejects calls to write tools in read-only mode', async () => {
    const { call, writes } = await connect({ readOnly: true });
    const result = await call('delete_expense', { expense_id: 9001 });
    expect(result.isError).toBe(true);
    expect(writes()).toHaveLength(0);
  });
});

describe('read tools', () => {
  it('get_current_user', async () => {
    const { call } = await connect();
    expect((await call('get_current_user')).json()).toEqual({
      id: 1,
      name: 'Riya Sharma',
      email: 'riya@example.com',
      default_currency: 'USD',
    });
  });

  it('get_balances summarises who owes whom per currency', async () => {
    const { call } = await connect();
    const balances = (await call('get_balances')).json();
    expect(balances.owes_you).toEqual([
      { friend: 'Alex Kim', friend_id: 2, amount: '42.50', currency: 'USD' },
      { friend: 'Sam Patel', friend_id: 4, amount: '10.00', currency: 'USD' },
      { friend: 'Sam Patel', friend_id: 4, amount: '7.50', currency: 'EUR' },
    ]);
    expect(balances.you_owe).toEqual([
      { friend: 'Alex Wu', friend_id: 3, amount: '12.25', currency: 'USD' },
      { friend: 'Zoë Müller', friend_id: 6, amount: '1500', currency: 'JPY' },
    ]);
    expect(balances.totals).toEqual([
      { currency: 'USD', owed_to_you: '52.50', you_owe: '12.25', net: '40.25' },
      { currency: 'EUR', owed_to_you: '7.50', you_owe: '0.00', net: '7.50' },
      { currency: 'JPY', owed_to_you: '0', you_owe: '1500', net: '-1500' },
    ]);
  });

  it('get_balances for a group lists debts by name', async () => {
    const { call } = await connect();
    const result = (await call('get_balances', { group: 'lisbon' })).json();
    expect(result.debts.map((d: { summary: string }) => d.summary)).toEqual([
      'Alex Kim owes Riya Sharma 20.00 USD',
      'Sam Patel owes Riya Sharma 10.00 USD',
    ]);
  });

  it('get_group uses original debts when simplification is off', async () => {
    const { call } = await connect();
    const group = (await call('get_group', { group: 'flat 4b' })).json();
    expect(group.members.map((m: { name: string }) => m.name)).toEqual(['Riya Sharma', 'Alex Wu', 'Jonathan Reed']);
    expect(group.debts[0].summary).toBe('Riya Sharma owes Alex Wu 12.25 USD');
  });

  it('list_groups shows your balance in each group', async () => {
    const { call } = await connect();
    const groups = (await call('list_groups')).json();
    expect(groups.find((g: { id: number }) => g.id === 100)).toEqual({
      id: 100,
      name: 'Lisbon Trip',
      members: ['Riya Sharma', 'Alex Kim', 'Sam Patel'],
      your_balance: [{ currency: 'USD', amount: '30.00' }],
    });
  });

  it('list_expenses resolves the group by name and hides deleted expenses', async () => {
    const { call, fake } = await connect();
    const expenses = (await call('list_expenses', { group: 'Lisbon', limit: 10 })).json();
    expect(fake.calls.find((c) => c.path === '/get_expenses')!.query).toMatchObject({ group_id: '100', limit: '10', offset: '0' });
    expect(expenses.map((e: { id: number }) => e.id)).toEqual([9001, 9002, 9003]);
    expect(expenses[0].shares[1]).toEqual({ user_id: 2, name: 'Alex Kim', paid: '0.00', owed: '30.00' });
  });

  it('search_expenses matches description and notes, accent-insensitively', async () => {
    const { call } = await connect();
    expect((await call('search_expenses', { query: 'pasteis' })).json().matches.map((e: { id: number }) => e.id)).toEqual([9002]);
    expect((await call('search_expenses', { query: 'alfama' })).json().matches.map((e: { id: number }) => e.id)).toEqual([9003]);
    expect((await call('search_expenses', { query: 'taxi' })).json().matches).toEqual([]);
  });

  it('search_expenses pages through history', async () => {
    const many = Array.from({ length: 250 }, (_, i) => expense({ id: i + 1, description: i === 230 ? 'Concert tickets' : `Item ${i}` }));
    const fake = fakeSplitwise({ expenses: many });
    const { call } = await connect({ fake });
    const result = (await call('search_expenses', { query: 'concert' })).json();
    expect(result.matches.map((e: { id: number }) => e.id)).toEqual([231]);
    expect(fake.calls.filter((c) => c.path === '/get_expenses').map((c) => c.query.offset)).toEqual(['0', '100', '200']);
  });

  it('returns ambiguity errors as tool errors', async () => {
    const { call } = await connect();
    const result = await call('list_expenses', { friend: 'alex' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/"alex" matches more than one friend: Alex Kim \(id 2\), Alex Wu \(id 3\)/);
  });
});

describe('write tools', () => {
  it('create_expense splits a group expense equally among all members', async () => {
    const { call, writes } = await connect();
    const result = await call('create_expense', { description: 'Tram tickets', cost: '10', group: 'lisbon' });
    expect(result.isError).toBe(false);
    expect(writes()[0]!.body).toEqual({
      cost: '10.00',
      currency_code: 'USD',
      description: 'Tram tickets',
      group_id: 100,
      users__0__user_id: 1,
      users__0__paid_share: '10.00',
      users__0__owed_share: '3.34',
      users__1__user_id: 2,
      users__1__paid_share: '0.00',
      users__1__owed_share: '3.33',
      users__2__user_id: 4,
      users__2__paid_share: '0.00',
      users__2__owed_share: '3.33',
    });
    expect(result.json().created.shares.map((s: { owed: string }) => s.owed)).toEqual(['3.34', '3.33', '3.33']);
  });

  it('create_expense accepts names, a different payer and percentages', async () => {
    const { call, writes } = await connect();
    const result = await call('create_expense', {
      description: 'Groceries',
      cost: 57.3,
      currency_code: 'eur',
      paid_by: 'Sam',
      split: { type: 'percentage', shares: [{ user: 'me', percent: 60 }, { user: 'sam patel', percent: 40 }] },
      date: '2026-04-01',
      notes: 'Pingo Doce',
    });
    expect(result.isError).toBe(false);
    expect(writes()[0]!.body).toEqual({
      cost: '57.30',
      currency_code: 'EUR',
      description: 'Groceries',
      group_id: 0,
      date: '2026-04-01T12:00:00Z',
      details: 'Pingo Doce',
      users__0__user_id: 1,
      users__0__paid_share: '0.00',
      users__0__owed_share: '34.38',
      users__1__user_id: 4,
      users__1__paid_share: '57.30',
      users__1__owed_share: '22.92',
    });
  });

  it('create_expense refuses ambiguous names without writing anything', async () => {
    const { call, writes } = await connect();
    const result = await call('create_expense', {
      description: 'Lunch',
      cost: '20',
      split: { type: 'equal', participants: ['me', 'alex'] },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/matches more than one person: Alex Kim \(id 2\), Alex Wu \(id 3\)/);
    expect(writes()).toHaveLength(0);
  });

  it('create_expense validates money before calling Splitwise', async () => {
    const { call, writes } = await connect();
    const cases = [
      [{ cost: '10.005' }, /more decimal places than USD allows/],
      [{ cost: '10', currency_code: 'DOGE' }, /not a currency code/],
      [{ cost: '10', split: { type: 'exact', shares: [{ user: 'me', amount: '4' }, { user: 'sam', amount: '5' }] } }, /short by 1.00 USD/],
      [{ cost: '10', split: { type: 'percentage', shares: [{ user: 'me', percent: 50 }, { user: 'sam', percent: 49 }] } }, /add up to 99/],
      [{ cost: '10', split: { type: 'equal' } }, /Name the people/],
    ] as const;
    for (const [args, message] of cases) {
      const result = await call('create_expense', { description: 'x', ...args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.text).toMatch(message);
    }
    expect(writes()).toHaveLength(0);
  });

  it('update_expense rescales shares when only the cost changes', async () => {
    const { call, writes } = await connect();
    const result = await call('update_expense', { expense_id: 9001, cost: '100' });
    expect(result.isError).toBe(false);
    const body = writes()[0]!.body!;
    expect(writes()[0]!.path).toBe('/update_expense/9001');
    expect(body).toMatchObject({
      cost: '100.00',
      users__0__paid_share: '100.00',
      users__0__owed_share: '33.34',
      users__1__owed_share: '33.33',
      users__2__owed_share: '33.33',
    });
  });

  it('update_expense changes only the description without touching shares', async () => {
    const { call, writes } = await connect();
    await call('update_expense', { expense_id: 9001, description: 'Dinner at Taberna da Rua' });
    expect(writes()[0]!.body).toEqual({ description: 'Dinner at Taberna da Rua' });
  });

  it('update_expense can move the payment to someone else', async () => {
    const { call, writes } = await connect();
    await call('update_expense', { expense_id: 9001, paid_by: 'alex kim' });
    expect(writes()[0]!.body).toMatchObject({
      users__0__user_id: 1,
      users__0__paid_share: '0.00',
      users__0__owed_share: '30.00',
      users__1__user_id: 2,
      users__1__paid_share: '90.00',
      users__1__owed_share: '30.00',
    });
  });

  it('update_expense refuses an empty update', async () => {
    const { call } = await connect();
    const result = await call('update_expense', { expense_id: 9001 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Nothing to update/);
  });

  it('delete_expense deletes and returns what was removed', async () => {
    const { call, writes } = await connect();
    const result = await call('delete_expense', { expense_id: 9001 });
    expect(writes().map((w) => w.path)).toEqual(['/delete_expense/9001']);
    expect(result.json().deleted.description).toBe('Dinner at Taberna');
  });

  it('delete_expense is idempotent for already-deleted expenses', async () => {
    const { call, writes } = await connect();
    const result = await call('delete_expense', { expense_id: 9004 });
    expect(result.json().note).toBe('Already deleted.');
    expect(writes()).toHaveLength(0);
  });

  it('settle_up records a payment for the full friend balance', async () => {
    const { call, writes } = await connect();
    const result = await call('settle_up', { from: 'alex kim', to: 'me' });
    expect(result.isError).toBe(false);
    expect(writes()[0]!.body).toEqual({
      payment: true,
      cost: '42.50',
      currency_code: 'USD',
      description: 'Payment',
      group_id: 0,
      users__0__user_id: 2,
      users__0__paid_share: '42.50',
      users__0__owed_share: '0.00',
      users__1__user_id: 1,
      users__1__paid_share: '0.00',
      users__1__owed_share: '42.50',
    });
    expect(result.json().recorded).toBe('Alex Kim paid Riya Sharma 42.50 USD');
  });

  it('settle_up uses group debts when a group is given', async () => {
    const { call, writes } = await connect();
    await call('settle_up', { from: 'sam', to: 'me', group: 'lisbon' });
    expect(writes()[0]!.body).toMatchObject({ cost: '10.00', group_id: 100, users__0__user_id: 4, users__1__user_id: 1 });
  });

  it('settle_up asks for a currency when the balance spans several', async () => {
    const { call, writes } = await connect();
    const result = await call('settle_up', { from: 'sam', to: 'me' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('Sam Patel owes Riya Sharma in several currencies (10.00 USD, 7.50 EUR). Pass currency_code to pick one.');
    const eur = await call('settle_up', { from: 'sam', to: 'me', currency_code: 'EUR' });
    expect(eur.json().recorded).toBe('Sam Patel paid Riya Sharma 7.50 EUR');
    expect(writes()).toHaveLength(1);
  });

  it('settle_up catches a reversed direction', async () => {
    const { call } = await connect();
    const result = await call('settle_up', { from: 'me', to: 'alex kim' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Riya Sharma does not owe Alex Kim; it is the other way round \(42.50 USD\)/);
  });

  it('settle_up records an explicit amount', async () => {
    const { call, writes } = await connect();
    await call('settle_up', { from: 'me', to: 'zoe', amount: '1500', currency_code: 'JPY' });
    expect(writes()[0]!.body).toMatchObject({ cost: '1500', currency_code: 'JPY', users__0__user_id: 1, users__1__user_id: 6 });
  });
});
