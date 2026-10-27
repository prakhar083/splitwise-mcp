import { describe, expect, it, vi } from 'vitest';
import { SplitwiseClient } from '../src/splitwise/client.js';
import { SplitwiseError, SplitwiseValidationError, extractErrors, parseRetryAfter } from '../src/splitwise/errors.js';
import { ME, fakeSplitwise } from './fixtures.js';

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

function clientWith(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const r of responses) fetch.mockResolvedValueOnce(r);
  const sleep = vi.fn(async (_ms: number) => {});
  return { client: new SplitwiseClient({ apiKey: 'test-key', fetch, sleep }), fetch, sleep };
}

async function failure(promise: Promise<unknown>): Promise<SplitwiseError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SplitwiseError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

describe('SplitwiseClient requests', () => {
  it('sends the API key as a bearer token to the v3.0 API', async () => {
    const fake = fakeSplitwise();
    const client = new SplitwiseClient({ apiKey: 'secret-123', fetch: fake.fetch });
    await expect(client.getCurrentUser()).resolves.toEqual(ME);
    const [url, init] = fake.mock.mock.calls[0]!;
    expect(String(url)).toBe('https://secure.splitwise.com/api/v3.0/get_current_user');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-123');
  });

  it('caches the current user but not after a failure', async () => {
    const { client, fetch } = clientWith(respond(500, {}), respond(200, { user: ME }));
    await expect(client.getCurrentUser()).rejects.toThrow(/server error/);
    await expect(client.getCurrentUser()).resolves.toEqual(ME);
    await expect(client.getCurrentUser()).resolves.toEqual(ME);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('encodes expense filters as query parameters and skips unset ones', async () => {
    const fake = fakeSplitwise();
    const client = new SplitwiseClient({ apiKey: 'k', fetch: fake.fetch });
    await client.getExpenses({ group_id: 100, dated_after: '2026-01-01', limit: 5, friend_id: undefined });
    expect(fake.calls[0]!.query).toEqual({ group_id: '100', dated_after: '2026-01-01', limit: '5' });
  });

  it('posts create_expense as JSON with flattened user shares', async () => {
    const fake = fakeSplitwise();
    const client = new SplitwiseClient({ apiKey: 'k', fetch: fake.fetch });
    const payload = {
      cost: '10.00',
      currency_code: 'USD',
      description: 'Coffee',
      group_id: 100,
      users__0__user_id: 1,
      users__0__paid_share: '10.00',
      users__0__owed_share: '5.00',
      users__1__user_id: 2,
      users__1__paid_share: '0.00',
      users__1__owed_share: '5.00',
    };
    const created = await client.createExpense(payload);
    expect(created.description).toBe('Coffee');
    const call = fake.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/create_expense');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.body).toEqual(payload);
  });

  it('supports a custom base URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(respond(200, { friends: [] }));
    const client = new SplitwiseClient({ apiKey: 'k', fetch, baseUrl: 'http://localhost:9999/api/v3.0/' });
    await client.getFriends();
    expect(String(fetch.mock.calls[0]![0])).toBe('http://localhost:9999/api/v3.0/get_friends');
  });
});

describe('SplitwiseClient error mapping', () => {
  it('explains a rejected API key (401)', async () => {
    const { client } = clientWith(respond(401, { error: 'Invalid API request: you are not logged in' }));
    const error = await failure(client.getGroups());
    expect(error.status).toBe(401);
    expect(error.message).toMatch(/rejected the API key.*SPLITWISE_API_KEY/);
  });

  it('explains the Splitwise Pro requirement (403)', async () => {
    const body = { errors: { base: ["This app's developer needs a Splitwise Pro subscription to use the API."] } };
    const { client } = clientWith(respond(403, body));
    const error = await failure(client.createExpense({}));
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/needs an active Splitwise Pro subscription on the account that registered the API key/);
    expect(error.message).toMatch(/Nothing was changed/);
  });

  it('treats other 403s as a membership problem', async () => {
    const { client } = clientWith(respond(403, { errors: { base: ['You are not allowed to view this group'] } }));
    const error = await failure(client.getGroup(5));
    expect(error.message).toBe(
      'Splitwise denied access (HTTP 403): You are not allowed to view this group. ' +
        'The account behind the API key is probably not a member of that group or expense.',
    );
  });

  it('reports 404s', async () => {
    const { client } = clientWith(respond(404, { errors: { base: ['Invalid expense'] } }));
    await expect(client.getExpense(1)).rejects.toThrow(/Not found on Splitwise \(HTTP 404\): Invalid expense/);
  });

  it('retries a rate-limited GET once when Retry-After is short', async () => {
    const { client, fetch, sleep } = clientWith(
      respond(429, {}, { 'Retry-After': '2' }),
      respond(200, { friends: [] }),
    );
    await expect(client.getFriends()).resolves.toEqual([]);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('surfaces Retry-After when it will not retry', async () => {
    const { client, sleep } = clientWith(respond(429, {}, { 'Retry-After': '120' }));
    const error = await failure(client.getFriends());
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(120);
    expect(error.message).toBe('Splitwise is rate limiting requests (HTTP 429). Retry after 120 seconds.');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('never retries writes, even on a short Retry-After', async () => {
    const { client, fetch } = clientWith(respond(429, {}, { 'Retry-After': '1' }));
    await expect(client.createExpense({})).rejects.toThrow(/Retry after 1 second\./);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after one retry', async () => {
    const { client, fetch } = clientWith(respond(429, {}, { 'Retry-After': '1' }), respond(429, {}, { 'Retry-After': '1' }));
    await expect(client.getGroups()).rejects.toThrow(/HTTP 429/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('turns an `errors` object on a 200 write into a validation error', async () => {
    const { client } = clientWith(
      respond(200, { expenses: [], errors: { base: ['The total of everyone\'s owed shares must equal the cost'], cost: ['is invalid'] } }),
    );
    const error = await failure(client.createExpense({}));
    expect(error).toBeInstanceOf(SplitwiseValidationError);
    expect(error.message).toBe(
      "Splitwise rejected the request: The total of everyone's owed shares must equal the cost; cost: is invalid",
    );
    expect((error as SplitwiseValidationError).details.cost).toEqual(['is invalid']);
  });

  it('maps 400 bodies with errors to validation errors', async () => {
    const { client } = clientWith(respond(400, { errors: { date: ['is not a date'] } }));
    await expect(client.updateExpense(1, {})).rejects.toThrow('Splitwise rejected the request: date: is not a date');
  });

  it('treats an unsuccessful delete as an error', async () => {
    const { client } = clientWith(respond(200, { success: false, errors: { base: ['Not allowed'] } }));
    await expect(client.deleteExpense(3)).rejects.toThrow('Splitwise rejected the request: Not allowed');
  });

  it('reports 5xx and network failures plainly', async () => {
    const { client } = clientWith(respond(502, '<html>Bad gateway</html>'));
    await expect(client.getGroups()).rejects.toThrow('Splitwise had a server error (HTTP 502). Try again shortly.');

    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const offline = new SplitwiseClient({ apiKey: 'k', fetch });
    await expect(offline.getGroups()).rejects.toThrow('Could not reach Splitwise: fetch failed.');
  });

  it('rejects non-JSON success bodies', async () => {
    const { client } = clientWith(respond(200, 'not json'));
    await expect(client.getGroups()).rejects.toThrow(/unexpected response/);
  });

  it('requires an API key', () => {
    expect(() => new SplitwiseClient({ apiKey: '' })).toThrow(/API key is required/);
  });
});

describe('error helpers', () => {
  it('normalises every Splitwise error shape', () => {
    expect(extractErrors({ errors: { base: ['a'], cost: 'b' } })).toEqual({ base: ['a'], cost: ['b'] });
    expect(extractErrors({ errors: ['x', 'y'] })).toEqual({ base: ['x', 'y'] });
    expect(extractErrors({ error: 'nope' })).toEqual({ base: ['nope'] });
    expect(extractErrors({ errors: {} })).toEqual({});
    expect(extractErrors(null)).toEqual({});
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('30', now)).toBe(30);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:45 GMT', now)).toBe(45);
    expect(parseRetryAfter('Wed, 31 Dec 2025 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});
