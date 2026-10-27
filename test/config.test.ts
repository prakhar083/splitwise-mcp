import { describe, expect, it } from 'vitest';
import { loadConfig, parseBoolean } from '../src/config.js';

describe('loadConfig', () => {
  it('requires an API key', () => {
    expect(() => loadConfig({})).toThrow(/SPLITWISE_API_KEY is not set/);
    expect(() => loadConfig({ SPLITWISE_API_KEY: '   ' })).toThrow(/SPLITWISE_API_KEY is not set/);
  });

  it('reads the key and read-only flag', () => {
    expect(loadConfig({ SPLITWISE_API_KEY: ' abc ' })).toEqual({ apiKey: 'abc', readOnly: false });
    expect(loadConfig({ SPLITWISE_API_KEY: 'abc', SPLITWISE_READ_ONLY: 'TRUE' }).readOnly).toBe(true);
  });

  it('rejects unclear booleans instead of guessing', () => {
    expect(parseBoolean('1', 'X')).toBe(true);
    expect(parseBoolean('off', 'X')).toBe(false);
    expect(parseBoolean(undefined, 'X')).toBe(false);
    expect(() => parseBoolean('maybe', 'SPLITWISE_READ_ONLY')).toThrow('SPLITWISE_READ_ONLY must be true or false, got "maybe".');
  });
});
