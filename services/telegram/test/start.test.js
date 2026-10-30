import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildOpenShopKeyboard,
  describeError,
  handleMessage,
  parseStartCommand,
} from '../tgcloud/lib/bot/start.js';
import { createRecordingApi } from './sdk-fake/api.js';
import { createFakeDb } from './sdk-fake/db.js';
import { createFakeFetch } from './sdk-fake/fetch.js';
import { ADR_VECTOR, TEST_CONFIG_ROWS, rowsFrom, silentLogger } from './helpers.js';

let api;
let db;
let fetch;
let log;

const message = (over = {}) => ({
  message_id: 1,
  text: '/start',
  chat: { id: 555, type: 'private' },
  from: { id: 555, first_name: 'Ann', language_code: 'ru' },
  ...over,
});

const setConfig = (extra = {}, base = TEST_CONFIG_ROWS) =>
  db.__setRows('service_config', rowsFrom({ ...base, ...extra }));

const run = (msg = message(), extra = {}) =>
  handleMessage(msg, {
    api,
    db,
    fetch,
    log,
    now: () => ADR_VECTOR.timestamp * 1000,
    nonce: () => ADR_VECTOR.nonce,
    ...extra,
  });

beforeEach(() => {
  api = createRecordingApi();
  db = createFakeDb();
  fetch = createFakeFetch(() => ({ body: '{"user":{"telegram_user_id":555}}' }));
  log = silentLogger();
});

describe('parseStartCommand', () => {
  it.each([
    ['/start', { payload: null }],
    ['/start abc_123-X', { payload: 'abc_123-X' }],
    ['/start@some_bot', { payload: null }],
    ['/start@some_bot ref', { payload: 'ref' }],
    ['  /start  ', { payload: null }],
    ['/start bad!payload', { payload: null }],
    ['/start ' + 'a'.repeat(65), { payload: null }],
  ])('parses %j', (text, expected) => {
    expect(parseStartCommand(text)).toEqual(expected);
  });

  it.each(['hello', '/help', '/starting', '/start one two', '', undefined, 42])(
    'ignores %j',
    (text) => {
      expect(parseStartCommand(text)).toBeNull();
    },
  );
});

describe('/start flow', () => {
  it('syncs the user and sends the greeting with a web_app button', async () => {
    setConfig({ mini_app_url: 'https://app.example.test/' });
    const result = await run();

    expect(result).toEqual({ handled: true, button: 'web_app' });
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].url).toBe('https://core.example.test/api/v1/internal/telegram/session');
    expect(fetch.calls[0].init.headers['X-MM-Actor']).toBe('tg:555');

    expect(api.calls).toHaveLength(1);
    const [{ method, params }] = api.calls;
    expect(method).toBe('sendMessage');
    expect(params.chat_id).toBe(555);
    expect(params.text).toContain('MuniraMarket');
    expect(params.text).toContain('Добро пожаловать'); // ru locale
    expect(params.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'Открыть магазин', web_app: { url: 'https://app.example.test/' } }],
      ],
    });
  });

  it('defaults to uz and handles /start with a payload', async () => {
    setConfig({ mini_app_url: 'https://app.example.test/' });
    await run(
      message({
        text: '/start promo-1',
        from: { id: 555, first_name: 'Ali', language_code: 'en' },
      }),
    );
    const { params } = api.calls[0];
    expect(params.text).toContain('xush kelibsiz');
    expect(params.reply_markup.inline_keyboard[0][0].text).toBe('Do‘konni ochish');
  });

  it('falls back to a t.me ?startapp url button when only bot_username is configured', async () => {
    setConfig({ bot_username: 'example_shop_bot' });
    expect((await run()).button).toBe('url');
    expect(api.calls[0].params.reply_markup.inline_keyboard[0][0]).toEqual({
      text: 'Открыть магазин',
      url: 'https://t.me/example_shop_bot?startapp',
    });

    api.reset();
    await run(message({ text: '/start promo-1' }));
    expect(api.calls[0].params.reply_markup.inline_keyboard[0][0].url).toBe(
      'https://t.me/example_shop_bot?startapp=promo-1',
    );
  });

  it('prefers mini_app_url over bot_username', async () => {
    setConfig({ mini_app_url: 'https://app.example.test/', bot_username: 'example_shop_bot' });
    expect((await run()).button).toBe('web_app');
  });

  it('sends the greeting without a button, and warns, when neither is configured', async () => {
    setConfig();
    expect(await run()).toEqual({ handled: true, button: 'none' });
    expect(api.calls[0].params).not.toHaveProperty('reply_markup');
    expect(log.entries.some((e) => e.level === 'warn' && /mini_app_url/.test(e.text))).toBe(true);
  });

  it('rejects a non-https mini_app_url (treated as absent)', async () => {
    setConfig({ mini_app_url: 'http://app.example.test/' });
    expect((await run()).button).toBe('none');
  });

  it('still replies when the Core API fails, without logging secrets or bodies', async () => {
    setConfig({ mini_app_url: 'https://app.example.test/' });
    fetch.__setHandler(() => ({ status: 500, body: 'boom leaked-body' }));
    const result = await run();
    expect(result.handled).toBe(true);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].params.reply_markup).toBeDefined();
    const logged = log.entries.map((e) => e.text).join('\n');
    expect(logged).toMatch(/user sync skipped/);
    expect(logged).toContain('status=500');
    expect(logged).not.toContain(ADR_VECTOR.secret);
    expect(logged).not.toContain('leaked-body');
  });

  it('still replies on network errors', async () => {
    setConfig({ mini_app_url: 'https://app.example.test/' });
    fetch.__setHandler(() => {
      throw new Error('ECONNRESET');
    });
    expect((await run()).handled).toBe(true);
    expect(api.calls).toHaveLength(1);
  });

  it('still replies when service config is missing/invalid and does not call the Core API', async () => {
    setConfig(
      { mini_app_url: 'https://app.example.test/' },
      {
        service_secret: 'tooshort',
        core_api_base_url: 'https://core.example.test',
        service_key_id: 'k',
      },
    );
    expect((await run()).handled).toBe(true);
    expect(fetch.calls).toHaveLength(0);
    expect(api.calls).toHaveLength(1);
    const logged = log.entries.map((e) => e.text).join('\n');
    expect(logged).not.toContain('tooshort');
  });

  it('still replies when the database is down', async () => {
    db.__failWith(new Error('db down'));
    expect((await run()).handled).toBe(true);
    expect(fetch.calls).toHaveLength(0);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].params).not.toHaveProperty('reply_markup');
  });
});

describe('ignored messages', () => {
  beforeEach(() => setConfig({ mini_app_url: 'https://app.example.test/' }));

  it.each([
    ['plain text', message({ text: 'hello' })],
    ['other command', message({ text: '/help' })],
    ['no text (photo)', message({ text: undefined })],
    ['group chat', message({ chat: { id: -100, type: 'supergroup' } })],
    ['no sender', message({ from: undefined })],
    ['bot sender', message({ from: { id: 9, is_bot: true, first_name: 'B' } })],
  ])('does nothing for %s', async (_name, msg) => {
    expect(await run(msg)).toEqual({ handled: false, button: null });
    expect(api.calls).toHaveLength(0);
    expect(fetch.calls).toHaveLength(0);
  });

  it('does nothing for a null message', async () => {
    expect((await run(null)).handled).toBe(false);
  });
});

describe('helpers', () => {
  it('buildOpenShopKeyboard returns null without any target', () => {
    expect(buildOpenShopKeyboard({ miniAppUrl: null, botUsername: null }, 'x', null)).toBeNull();
  });

  it('describeError exposes only name/status/code', () => {
    const error = Object.assign(new Error('has secret-value'), {
      name: 'CoreApiError',
      status: 500,
      code: 'UPSTREAM_ERROR',
    });
    expect(describeError(error)).toBe('CoreApiError status=500 code=UPSTREAM_ERROR');
    expect(describeError('x')).toBe('non-error thrown');
  });
});
