/**
 * Errors raised by the Splitwise client. Messages are written for the model
 * (and, through it, the user): say what went wrong and what to do next.
 */

export class SplitwiseError extends Error {
  override name = 'SplitwiseError';
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** Splitwise accepted the request but rejected its contents (HTTP 200/400 with an `errors` object). */
export class SplitwiseValidationError extends SplitwiseError {
  override name = 'SplitwiseValidationError';
  constructor(readonly details: Record<string, string[]>) {
    super(`Splitwise rejected the request: ${formatErrorDetails(details)}`, 400);
  }
}

/**
 * Splitwise reports errors in several shapes:
 *   { "errors": { "base": ["..."], "cost": ["..."] } }
 *   { "errors": ["..."] }
 *   { "error": "..." }
 * Normalise them to field -> messages.
 */
export function extractErrors(body: unknown): Record<string, string[]> {
  if (!body || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  const add = (field: string, value: unknown) => {
    const messages = (Array.isArray(value) ? value : [value]).filter((v) => v !== null && v !== undefined && v !== '');
    if (messages.length > 0) (out[field] ??= []).push(...messages.map(String));
  };
  const { errors, error } = record;
  if (Array.isArray(errors)) add('base', errors);
  else if (errors && typeof errors === 'object') {
    for (const [field, value] of Object.entries(errors)) add(field, value);
  } else if (typeof errors === 'string') add('base', errors);
  if (typeof error === 'string') add('base', error);
  return out;
}

export function formatErrorDetails(details: Record<string, string[]>): string {
  return Object.entries(details)
    .map(([field, messages]) => (field === 'base' ? messages.join('; ') : `${field}: ${messages.join('; ')}`))
    .join('; ');
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

export function errorForResponse(status: number, body: unknown, rawText: string, retryAfter: string | null): SplitwiseError {
  const details = extractErrors(body);
  const detailText = Object.keys(details).length > 0 ? formatErrorDetails(details) : rawText.slice(0, 300);

  switch (true) {
    case status === 401:
      return new SplitwiseError(
        'Splitwise rejected the API key (HTTP 401). Check that SPLITWISE_API_KEY holds a valid key: ' +
          'register an app at https://secure.splitwise.com/apps and copy its API key.',
        status,
      );
    case status === 403 && /pro subscription/i.test(rawText):
      // Splitwise gates some third-party API access behind Splitwise Pro. The raw
      // message blames "the app's developer", which for a personal API key is the
      // user themselves, so spell that out.
      return new SplitwiseError(
        'Splitwise refused this request because it needs an active Splitwise Pro subscription on the account ' +
          'that registered the API key (at https://secure.splitwise.com/apps). Nothing was changed. ' +
          'Read-only tools may still work; writes need Pro on that account.',
        status,
      );
    case status === 403:
      return new SplitwiseError(
        `Splitwise denied access (HTTP 403)${detailText ? `: ${detailText}` : ''}. ` +
          'The account behind the API key is probably not a member of that group or expense.',
        status,
      );
    case status === 404:
      return new SplitwiseError(
        `Not found on Splitwise (HTTP 404)${detailText ? `: ${detailText}` : ''}. Check the id; it may have been deleted.`,
        status,
      );
    case status === 429: {
      const seconds = parseRetryAfter(retryAfter);
      return new SplitwiseError(
        `Splitwise is rate limiting requests (HTTP 429). ${
          seconds !== undefined ? `Retry after ${seconds} second${seconds === 1 ? '' : 's'}.` : 'Wait a little and retry.'
        }`,
        status,
        seconds,
      );
    }
    case status === 400 || status === 422:
      return Object.keys(details).length > 0
        ? new SplitwiseValidationError(details)
        : new SplitwiseError(`Splitwise rejected the request (HTTP ${status}): ${detailText}`, status);
    case status >= 500:
      return new SplitwiseError(`Splitwise had a server error (HTTP ${status}). Try again shortly.`, status);
    default:
      return new SplitwiseError(`Splitwise request failed (HTTP ${status})${detailText ? `: ${detailText}` : ''}`, status);
  }
}
