import { describe, expect, it } from 'vitest';
import {
  ResolutionError,
  editDistance,
  groupCandidate,
  normalize,
  resolveMany,
  resolveOne,
  userCandidate,
} from '../src/resolve.js';
import { ALEX_KIM, ALEX_WU, JONATHAN, ME, SAM, ZOE, groups } from './fixtures.js';

const people = [ME, ALEX_KIM, ALEX_WU, SAM, JONATHAN, ZOE].map(userCandidate);
const resolve = (ref: string | number) => resolveOne(ref, people, { kind: 'person', selfId: ME.id }).id;

describe('normalize', () => {
  it('folds case, accents and punctuation', () => {
    expect(normalize('  Zoë   MÜLLER ')).toBe('zoe muller');
    expect(normalize("O'Brien-Smith")).toBe('o brien smith');
    expect(normalize('Sam@Example.com')).toBe('sam@example.com');
  });
});

describe('editDistance', () => {
  it('counts edits, treating an adjacent swap as one', () => {
    expect(editDistance('jonh', 'john')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('sam', 'sam')).toBe(0);
    expect(editDistance('samm', 'sam')).toBe(1);
    expect(editDistance('a', 'abcdefgh', 3)).toBe(4);
  });
});

describe('resolveOne', () => {
  it('accepts ids as numbers or numeric strings', () => {
    expect(resolve(4)).toBe(SAM.id);
    expect(resolve('4')).toBe(SAM.id);
  });

  it('rejects ids outside the pool', () => {
    expect(() => resolve(77)).toThrow(/No person with id 77/);
  });

  it('maps "me" and friends to the current user', () => {
    expect(resolve('me')).toBe(ME.id);
    expect(resolve('Myself')).toBe(ME.id);
  });

  it('matches full names, first names and emails case-insensitively', () => {
    expect(resolve('sam patel')).toBe(SAM.id);
    expect(resolve('SAM')).toBe(SAM.id);
    expect(resolve('patel')).toBe(SAM.id);
    expect(resolve('alex.kim@example.com')).toBe(ALEX_KIM.id);
  });

  it('ignores accents', () => {
    expect(resolve('zoe')).toBe(ZOE.id);
    expect(resolve('Zoe Muller')).toBe(ZOE.id);
  });

  it('matches prefixes and initials', () => {
    expect(resolve('jon')).toBe(JONATHAN.id);
    expect(resolve('alex k')).toBe(ALEX_KIM.id);
    expect(resolve('a wu')).toBe(ALEX_WU.id);
  });

  it('tolerates small typos in longer names', () => {
    expect(resolve('jonathon')).toBe(JONATHAN.id);
    expect(resolve('sam patle')).toBe(SAM.id);
    expect(resolve('patle')).toBe(SAM.id);
  });

  it('does not fuzz short names into a different person', () => {
    expect(() => resolve('Max')).toThrow(/No person matches "Max"/);
  });

  it('asks for disambiguation instead of guessing', () => {
    let error: unknown;
    try {
      resolve('alex');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ResolutionError);
    expect((error as Error).message).toBe(
      '"alex" matches more than one person: Alex Kim (id 2), Alex Wu (id 3). ' +
        'Ask which one is meant, then pass the id or a fuller name.',
    );
  });

  it('prefers a stricter match over a looser one', () => {
    const pool = [
      userCandidate({ id: 10, first_name: 'Ann', last_name: 'Lee' }),
      userCandidate({ id: 11, first_name: 'Anna', last_name: 'Park' }),
    ];
    // "ann" is an exact word for Ann Lee and only a prefix for Anna: not ambiguous.
    expect(resolveOne('ann', pool, { kind: 'person' }).id).toBe(10);
    expect(resolveOne('anna', pool, { kind: 'person' }).id).toBe(11);
  });

  it('lists the choices when nothing matches', () => {
    expect(() => resolve('Priyanka')).toThrow(/Available: Riya Sharma \(id 1\), Alex Kim \(id 2\)/);
  });

  it('resolves groups by partial name', () => {
    const pool = groups().map(groupCandidate);
    expect(resolveOne('lisbon', pool, { kind: 'group' }).id).toBe(100);
    expect(resolveOne('flat', pool, { kind: 'group' }).id).toBe(200);
    expect(() => resolveOne('Paris', pool, { kind: 'group' })).toThrow(/No group matches "Paris"/);
  });
});

describe('resolveMany', () => {
  it('keeps order', () => {
    expect(resolveMany(['sam', 'me', 'alex wu'], people, { kind: 'person', selfId: 1 }).map((c) => c.id)).toEqual([4, 1, 3]);
  });

  it('rejects the same person named twice', () => {
    expect(() => resolveMany(['Sam', 'sam patel'], people, { kind: 'person' })).toThrow(
      '"Sam" and "sam patel" both refer to Sam Patel (id 4). List each person once.',
    );
  });
});
