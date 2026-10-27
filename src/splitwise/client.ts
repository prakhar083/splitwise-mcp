import { SplitwiseError, SplitwiseValidationError, errorForResponse, extractErrors } from './errors.js';
import type { Expense, ExpensePayload, ExpenseQuery, Friend, Group, User } from './types.js';

export const DEFAULT_BASE_URL = 'https://secure.splitwise.com/api/v3.0';

export interface SplitwiseClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** GET requests rate-limited with a Retry-After at or below this are retried once. */
  maxRetryAfterSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Thin, typed wrapper over the Splitwise v3.0 REST API. Knows about HTTP and
 * Splitwise's error conventions; knows nothing about MCP.
 */
export class SplitwiseClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetryAfterSeconds: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private currentUser?: Promise<User>;

  constructor(options: SplitwiseClientOptions) {
    if (!options.apiKey) throw new SplitwiseError('A Splitwise API key is required.');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 10;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The authenticated user. Cached for the life of the client. */
  getCurrentUser(): Promise<User> {
    this.currentUser ??= this.request<{ user: User }>('GET', '/get_current_user').then(
      (r) => r.user,
      (error: unknown) => {
        this.currentUser = undefined;
        throw error;
      },
    );
    return this.currentUser;
  }

  async getGroups(): Promise<Group[]> {
    return (await this.request<{ groups: Group[] }>('GET', '/get_groups')).groups;
  }

  async getGroup(id: number): Promise<Group> {
    return (await this.request<{ group: Group }>('GET', `/get_group/${id}`)).group;
  }

  async getFriends(): Promise<Friend[]> {
    return (await this.request<{ friends: Friend[] }>('GET', '/get_friends')).friends;
  }

  async getExpenses(query: ExpenseQuery = {}): Promise<Expense[]> {
    return (await this.request<{ expenses: Expense[] }>('GET', '/get_expenses', { query })).expenses;
  }

  async getExpense(id: number): Promise<Expense> {
    return (await this.request<{ expense: Expense }>('GET', `/get_expense/${id}`)).expense;
  }

  async createExpense(payload: ExpensePayload): Promise<Expense> {
    return this.writeExpense('/create_expense', payload);
  }

  async updateExpense(id: number, payload: ExpensePayload): Promise<Expense> {
    return this.writeExpense(`/update_expense/${id}`, payload);
  }

  async deleteExpense(id: number): Promise<void> {
    const body = await this.request<{ success?: boolean; errors?: unknown }>('POST', `/delete_expense/${id}`);
    const errors = extractErrors(body);
    if (body.success !== true || Object.keys(errors).length > 0) {
      throw Object.keys(errors).length > 0
        ? new SplitwiseValidationError(errors)
        : new SplitwiseError(`Splitwise did not delete expense ${id}.`);
    }
  }

  /** Splitwise answers create/update with HTTP 200 and an `errors` object when validation fails. */
  private async writeExpense(path: string, payload: ExpensePayload): Promise<Expense> {
    const body = await this.request<{ expenses?: Expense[]; errors?: unknown }>('POST', path, { body: payload });
    const errors = extractErrors(body);
    if (Object.keys(errors).length > 0) throw new SplitwiseValidationError(errors);
    const expense = body.expenses?.[0];
    if (!expense) throw new SplitwiseError('Splitwise returned no expense and no error. Check Splitwise before retrying.');
    return expense;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { query?: object; body?: ExpensePayload } = {},
    attempt = 0,
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? (error.name === 'TimeoutError' ? 'request timed out' : error.message) : String(error);
      throw new SplitwiseError(`Could not reach Splitwise: ${reason}.`);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const error = errorForResponse(response.status, body, text, response.headers.get('retry-after'));
      const canRetry =
        method === 'GET' &&
        attempt === 0 &&
        response.status === 429 &&
        error.retryAfterSeconds !== undefined &&
        error.retryAfterSeconds <= this.maxRetryAfterSeconds;
      if (canRetry) {
        await this.sleep(error.retryAfterSeconds! * 1000);
        return this.request<T>(method, path, options, attempt + 1);
      }
      throw error;
    }
    if (body === undefined || typeof body !== 'object') {
      throw new SplitwiseError(`Splitwise returned an unexpected response for ${path}.`, response.status);
    }
    return body as T;
  }
}
