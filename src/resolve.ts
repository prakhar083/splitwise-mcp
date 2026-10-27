/**
 * Resolves what a person typed ("alex", "Sam P", "me", 12345) to a Splitwise
 * user or group. Matching is case- and accent-insensitive and works in tiers,
 * from strict to loose; the first tier with any match wins. If that tier has
 * more than one match, the caller gets a disambiguation error listing the
 * candidates instead of a guess.
 */

import type { Group, User } from './splitwise/types.js';

export class ResolutionError extends Error {
  override name = 'ResolutionError';
}

export type Reference = string | number;

export interface Candidate<T> {
  id: number;
  /** Names to match against, most specific first (e.g. full name, then email). */
  names: string[];
  label: string;
  value: T;
}

const SELF_ALIASES = new Set(['me', 'i', 'myself', 'self', 'you']);

export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.+]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function fullName(user: Pick<User, 'first_name' | 'last_name'>): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
}

export function userLabel(user: User): string {
  return `${fullName(user) || user.email || 'Unknown'} (id ${user.id})`;
}

export function userCandidate(user: User): Candidate<User> {
  return {
    id: user.id,
    names: [fullName(user), user.email ?? ''].filter(Boolean),
    label: userLabel(user),
    value: user,
  };
}

export function groupCandidate(group: Group): Candidate<Group> {
  return { id: group.id, names: [group.name], label: `${group.name} (id ${group.id})`, value: group };
}

/** Levenshtein distance, capped for speed: returns cap + 1 once it is exceeded. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      curr.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > cap) return cap + 1;
    prev = curr;
  }
  return prev[b.length]!;
}

/** Typos allowed for a query of this length: none for short names, where a typo is usually another name. */
function typoBudget(length: number): number {
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  return 2;
}

type Tier = (query: string, names: string[]) => boolean;

const TIERS: Tier[] = [
  // Exact full name or email.
  (q, names) => names.some((n) => n === q),
  // Exact match on any single word ("alex" -> "Alex Kim").
  (q, names) => names.some((n) => n.split(' ').includes(q)),
  // Every query word is a prefix of some name word ("al k" -> "Alex Kim").
  (q, names) => {
    const parts = q.split(' ');
    return names.some((n) => {
      const words = n.split(' ');
      return parts.every((p) => words.some((w) => w.startsWith(p)));
    });
  },
  // Substring anywhere.
  (q, names) => names.some((n) => n.includes(q)),
  // Small typos against the whole name or any word ("jonh" -> "John").
  (q, names) => {
    const budget = typoBudget(q.length);
    if (budget === 0) return false;
    return names.some((n) => [n, ...n.split(' ')].some((w) => editDistance(q, w, budget) <= budget));
  },
];

export interface ResolveOptions {
  /** What is being resolved, for error messages: "member", "friend", "group". */
  kind: string;
  /** Id returned for "me" / "myself". */
  selfId?: number;
}

export function resolveOne<T>(ref: Reference, candidates: Candidate<T>[], options: ResolveOptions): Candidate<T> {
  const { kind } = options;
  const asText = String(ref).trim();

  if (typeof ref === 'number' || /^\d+$/.test(asText)) {
    const id = Number(asText);
    const found = candidates.find((c) => c.id === id);
    if (found) return found;
    throw new ResolutionError(`No ${kind} with id ${id}. ${listChoices(candidates)}`);
  }

  const query = normalize(asText);
  if (!query) throw new ResolutionError(`Empty ${kind} name.`);

  if (options.selfId !== undefined && SELF_ALIASES.has(query)) {
    const self = candidates.find((c) => c.id === options.selfId);
    if (self) return self;
    throw new ResolutionError(`You are not among the ${kind}s here. ${listChoices(candidates)}`);
  }

  const normalized = candidates.map((c) => ({ candidate: c, names: c.names.map(normalize).filter(Boolean) }));
  for (const tier of TIERS) {
    const matches = normalized.filter(({ names }) => tier(query, names)).map(({ candidate }) => candidate);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new ResolutionError(
        `"${asText}" matches more than one ${kind}: ${matches.map((m) => m.label).join(', ')}. ` +
          'Ask which one is meant, then pass the id or a fuller name.',
      );
    }
  }
  throw new ResolutionError(`No ${kind} matches "${asText}". ${listChoices(candidates)}`);
}

/** Resolves several references and rejects duplicates ("Alex" and "alex kim" naming the same person). */
export function resolveMany<T>(refs: Reference[], candidates: Candidate<T>[], options: ResolveOptions): Candidate<T>[] {
  const resolved = refs.map((ref) => resolveOne(ref, candidates, options));
  const seen = new Map<number, Reference>();
  resolved.forEach((c, i) => {
    const earlier = seen.get(c.id);
    if (earlier !== undefined) {
      throw new ResolutionError(`"${earlier}" and "${refs[i]}" both refer to ${c.label}. List each person once.`);
    }
    seen.set(c.id, refs[i]!);
  });
  return resolved;
}

function listChoices(candidates: Candidate<unknown>[]): string {
  if (candidates.length === 0) return 'There are none to choose from.';
  const shown = candidates.slice(0, 25).map((c) => c.label);
  const more = candidates.length > shown.length ? `, and ${candidates.length - shown.length} more` : '';
  return `Available: ${shown.join(', ')}${more}.`;
}
