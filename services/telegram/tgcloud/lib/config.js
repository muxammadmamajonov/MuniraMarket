// @ts-check
/**
 * Loads this bot's operational configuration from the Serverless database (`service_config`).
 *
 * Fail-closed: anything missing or malformed raises `ConfigError`. Error messages name the config
 * KEY that is wrong but never echo a value, so the signing secret cannot leak through logs.
 */
import { serviceConfig } from '../schema.js';
import { utf8Encode } from './crypto/index.js';
import { MIN_SECRET_BYTES } from './coreApi/signer.js';
import { parseHttpUrl } from './url.js';

export const CONFIG_KEYS = Object.freeze({
  coreApiBaseUrl: 'core_api_base_url',
  serviceKeyId: 'service_key_id',
  serviceSecret: 'service_secret',
  miniAppUrl: 'mini_app_url',
  botUsername: 'bot_username',
});

export class ConfigError extends Error {
  /**
   * @param {string} key the config key at fault (never a value)
   * @param {string} problem short description without values
   */
  constructor(key, problem) {
    super(`Invalid service config "${key}": ${problem}`);
    this.name = 'ConfigError';
    this.key = key;
  }
}

/**
 * Minimal structural type of the SDK `db` we use. Injectable for tests.
 * @typedef {object} ConfigDb
 * @property {() => { from: (table: any) => { all: () => Promise<Array<Record<string, unknown>>> } }} select
 */

/**
 * Reads all rows of `service_config` into a plain object. The table is tiny, so one query beats
 * several round trips.
 *
 * @param {ConfigDb} db
 * @returns {Promise<Record<string, string>>}
 */
export async function readConfigRows(db) {
  const rows = await db.select().from(serviceConfig).all();
  /** @type {Record<string, string>} */
  const out = Object.create(null);
  for (const row of rows) {
    if (typeof row.key === 'string' && typeof row.value === 'string') out[row.key] = row.value;
  }
  return out;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * @param {string | undefined} raw
 * @returns {string} normalised origin (`https://host[:port]`)
 */
function parseCoreApiBaseUrl(raw) {
  const key = CONFIG_KEYS.coreApiBaseUrl;
  if (raw === undefined || raw.trim() === '') throw new ConfigError(key, 'missing');
  const parsed = parseHttpUrl(raw);
  if (!parsed) throw new ConfigError(key, 'not a valid http(s) URL without query or fragment');
  if (parsed.path !== '' && parsed.path !== '/') {
    throw new ConfigError(key, 'must be an origin without a path');
  }
  if (parsed.scheme !== 'https' && !LOCAL_HOSTS.has(parsed.host)) {
    throw new ConfigError(key, 'must use https (http is allowed only for localhost)');
  }
  return `${parsed.scheme}://${parsed.host}${parsed.port === '' ? '' : `:${parsed.port}`}`;
}

/**
 * Validates the Core API signing configuration.
 *
 * @param {Record<string, string>} rows
 * @returns {import('./types.js').ServiceConfig}
 */
export function parseServiceConfig(rows) {
  const baseUrl = parseCoreApiBaseUrl(rows[CONFIG_KEYS.coreApiBaseUrl]);

  const keyId = rows[CONFIG_KEYS.serviceKeyId];
  if (keyId === undefined || keyId === '')
    throw new ConfigError(CONFIG_KEYS.serviceKeyId, 'missing');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) {
    throw new ConfigError(CONFIG_KEYS.serviceKeyId, 'must match [A-Za-z0-9_-]{1,32}');
  }

  const secret = rows[CONFIG_KEYS.serviceSecret];
  if (secret === undefined || secret === '') {
    throw new ConfigError(CONFIG_KEYS.serviceSecret, 'missing');
  }
  if (utf8Encode(secret).length < MIN_SECRET_BYTES) {
    throw new ConfigError(CONFIG_KEYS.serviceSecret, `shorter than ${MIN_SECRET_BYTES} bytes`);
  }

  return { baseUrl, keyId, secret };
}

/**
 * Loads and validates the Core API configuration. Throws `ConfigError` on any problem.
 *
 * @param {ConfigDb} db the SDK `db` (or a test double)
 * @returns {Promise<import('./types.js').ServiceConfig>}
 */
export async function loadServiceConfig(db) {
  return parseServiceConfig(await readConfigRows(db));
}

/**
 * Optional bot presentation config. Invalid optional values are treated as absent (and reported
 * in `warnings`) rather than throwing, so a bad optional row cannot take down `/start`.
 *
 * @param {Record<string, string>} rows
 * @returns {{ miniAppUrl: string | null, botUsername: string | null, warnings: string[] }}
 */
export function parseBotConfig(rows) {
  /** @type {string[]} */
  const warnings = [];

  let miniAppUrl = null;
  const rawUrl = rows[CONFIG_KEYS.miniAppUrl];
  if (rawUrl !== undefined && rawUrl.trim() !== '') {
    const parsed = parseHttpUrl(rawUrl);
    if (parsed && parsed.scheme === 'https') miniAppUrl = rawUrl.trim();
    else warnings.push(`${CONFIG_KEYS.miniAppUrl} ignored: must be an https URL`);
  }

  let botUsername = null;
  const rawUsername = rows[CONFIG_KEYS.botUsername];
  if (rawUsername !== undefined && rawUsername.trim() !== '') {
    const candidate = rawUsername.trim().replace(/^@/, '');
    if (/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(candidate)) botUsername = candidate;
    else warnings.push(`${CONFIG_KEYS.botUsername} ignored: not a valid Telegram username`);
  }

  return { miniAppUrl, botUsername, warnings };
}
