import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type Candidate, type Reference, groupCandidate, resolveOne, userCandidate } from '../resolve.js';
import type { SplitwiseClient } from '../splitwise/client.js';
import type { Friend, Group, User } from '../splitwise/types.js';

export const personRef = z
  .union([z.number().int().positive(), z.string().trim().min(1)])
  .describe('A person: their Splitwise user id, a name (first, full, or partial, case-insensitive), an email, or "me".');

export const groupRef = z
  .union([z.number().int().nonnegative(), z.string().trim().min(1)])
  .describe('A group: its Splitwise id or its name (case-insensitive, partial names work).');

export const amount = z
  .union([z.string().trim().min(1), z.number().positive()])
  .describe('A decimal amount such as "42.50". Prefer strings to avoid float rounding.');

export const currencyCode = z
  .string()
  .trim()
  .describe('3-letter ISO 4217 currency code, e.g. USD, EUR, INR, JPY.');

export const isoDate = z
  .string()
  .trim()
  .describe('A date as YYYY-MM-DD, or an ISO 8601 timestamp.');

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Wraps a tool body: its return value becomes a JSON text result, and any
 * error becomes an `isError` result the model can read and act on, rather than
 * a protocol-level failure.
 */
export function handle<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return jsonResult(await fn(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

/**
 * Looks up groups, friends and members by id or name. Nothing is cached apart
 * from the current user, so every tool call sees fresh balances.
 */
export class Directory {
  constructor(readonly client: SplitwiseClient) {}

  me(): Promise<User> {
    return this.client.getCurrentUser();
  }

  async resolveGroup(ref: Reference): Promise<Group> {
    const groups = (await this.client.getGroups()).filter((g) => g.id !== 0);
    // get_groups already carries members, balances and debts, so no second request is needed.
    return resolveOne(ref, groups.map(groupCandidate), { kind: 'group' }).value;
  }

  async resolveFriend(ref: Reference): Promise<Friend> {
    const [me, friends] = await Promise.all([this.me(), this.client.getFriends()]);
    return resolveOne(ref, friends.map(userCandidate), { kind: 'friend', selfId: me.id }).value as Friend;
  }

  /** Who can take part in an expense: the group's members, or you and your friends for a non-group expense. */
  async people(group?: Group, extra: User[] = []): Promise<Candidate<User>[]> {
    const users: User[] = group ? [...group.members] : [await this.me(), ...(await this.client.getFriends())];
    for (const user of extra) if (!users.some((u) => u.id === user.id)) users.push(user);
    return users.map(userCandidate);
  }
}
