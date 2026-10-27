export interface Config {
  apiKey: string;
  readOnly: boolean;
  baseUrl?: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['', '0', 'false', 'no', 'off']);

export function parseBoolean(value: string | undefined, name: string): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  if (TRUE.has(normalized)) return true;
  if (FALSE.has(normalized)) return false;
  throw new ConfigError(`${name} must be true or false, got "${value}".`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.SPLITWISE_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      'SPLITWISE_API_KEY is not set. Register an app at https://secure.splitwise.com/apps, ' +
        'copy its API key, and pass it to the server as the SPLITWISE_API_KEY environment variable.',
    );
  }
  const baseUrl = env.SPLITWISE_BASE_URL?.trim();
  return {
    apiKey,
    readOnly: parseBoolean(env.SPLITWISE_READ_ONLY, 'SPLITWISE_READ_ONLY'),
    ...(baseUrl ? { baseUrl } : {}),
  };
}
