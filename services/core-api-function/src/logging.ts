/**
 * Structured JSON logs with a last-line-of-defence redactor (port of
 * services/api/app/core/logging.py). Callers never log bodies, headers, cookies, query strings,
 * addresses, phone numbers or initData; `redact` masks anything that slips through.
 */

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const REDACTED = '[redacted]';
export const MAX_LOG_TEXT = 8000;

const SECRET_KEY_PARTS =
  /authorization|cookie|token|csrf|hash|signature|init_?data|password|passwd|secret|api_?key|mm_session|mm_oidc|code_?verifier|nonce/i;
const KEY = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+/g;
const ASSIGNED_VALUE = /^"?\s*[:=]\s*"?([^\s"',;&]+)/;

function maskSecretValues(text: string): string {
  const parts: string[] = [];
  let position = 0;
  for (const key of text.matchAll(KEY)) {
    const start = key.index;
    if (start < position || !SECRET_KEY_PARTS.test(key[0])) continue;
    const after = start + key[0].length;
    const value = ASSIGNED_VALUE.exec(text.slice(after));
    if (value === null || value[1] === REDACTED || value[1] === undefined) continue;
    const valueStart = after + value[0].length - value[1].length;
    parts.push(text.slice(position, valueStart), REDACTED);
    position = valueStart + value[1].length;
  }
  parts.push(text.slice(position));
  return parts.join('');
}

const BEFORE_KEYS: ReadonlyArray<[RegExp, string]> = [
  // Credentials inside URLs: postgresql://user:password@host.
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, `$1${REDACTED}@`],
  // Telegram bot tokens: <bot id>:<35+ url-safe characters>.
  [/(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g, REDACTED],
  // Authorization values with their scheme.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
];
const AFTER_KEYS: ReadonlyArray<[RegExp, string]> = [
  [/\+?998[\s()-]*\d{2}[\s()-]*\d{3}[\s()-]*\d{2}[\s()-]*\d{2}/g, REDACTED],
  [/(?<![\w-])\(?\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?![\w-])/g, REDACTED],
  [/(?<![\w-])\+\d[\d\s()-]{7,}\d/g, REDACTED],
];

function cut(text: string): string {
  if (text.length <= MAX_LOG_TEXT) return text;
  const window = text.slice(0, MAX_LOG_TEXT);
  const boundary = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'));
  const kept = boundary > 0 ? window.slice(0, boundary) : '';
  return `${kept}...[truncated ${text.length - kept.length} chars]`;
}

export function redact(text: string): string {
  let result = cut(text);
  for (const [pattern, replacement] of BEFORE_KEYS) result = result.replace(pattern, replacement);
  result = maskSecretValues(result);
  for (const [pattern, replacement] of AFTER_KEYS) result = result.replace(pattern, replacement);
  return result;
}

type Level = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
const RANK: Readonly<Record<Level, number>> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warning(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function safeField(value: unknown): unknown {
  if (typeof value === 'string') return redact(value).slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return redact(String(value)).slice(0, 500);
}

export function createLogger(
  options: { level?: Level; release?: string | null; env?: string } = {},
): Logger {
  const threshold = RANK[options.level ?? 'INFO'];
  const emit = (level: Level, message: string, fields: Record<string, unknown> = {}) => {
    if (RANK[level] < threshold) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      service: 'core-api-function',
      msg: redact(message),
    };
    if (options.env) entry['env'] = options.env;
    if (options.release) entry['release'] = options.release;
    for (const [key, value] of Object.entries(fields)) entry[key] = safeField(value);
    const line = JSON.stringify(entry);
    if (RANK[level] >= RANK.WARNING) console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, f) => emit('DEBUG', m, f),
    info: (m, f) => emit('INFO', m, f),
    warning: (m, f) => emit('WARNING', m, f),
    error: (m, f) => emit('ERROR', m, f),
  };
}

/**
 * Error fields that are safe to log: class, SQLSTATE/system code and constraint, never the
 * message. PostgreSQL's `DETAIL: Failing row contains (...)` would put order data (recipient,
 * phone, address) into the logs, and driver/network messages can carry the database host.
 */
export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const fields: Record<string, unknown> = { error: error.name };
    const extra = error as Error & { code?: unknown; constraint?: unknown };
    if (typeof extra.code === 'string' && /^[0-9A-Z_]{2,32}$/.test(extra.code)) {
      fields[/^[0-9A-Z]{5}$/.test(extra.code) ? 'sqlstate' : 'code'] = extra.code;
    }
    if (typeof extra.constraint === 'string' && /^[a-z0-9_]{1,63}$/.test(extra.constraint)) {
      fields['constraint'] = extra.constraint;
    }
    return fields;
  }
  return { error: 'non-error thrown' };
}
