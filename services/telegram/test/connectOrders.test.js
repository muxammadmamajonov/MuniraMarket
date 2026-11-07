import { beforeEach, describe, expect, it } from 'vitest';
import { BotApiError } from 'sdk';
import {
  GROUP_ANONYMOUS_BOT_ID,
  handleConnectOrders,
  parseConnectOrdersCommand,
} from '../tgcloud/lib/bot/connectOrders.js';
import { STAFF_MESSAGES } from '../tgcloud/lib/i18n.js';
import { createRecordingApi } from './sdk-fake/api.js';
import { createFakeDb } from './sdk-fake/db.js';
import { createFakeFetch } from './sdk-fake/fetch.js';
import { ADR_VECTOR, TEST_CONFIG_ROWS, rowsFrom, silentLogger } from './helpers.js';

const GROUP_ID = -1001234567890;
const ADMIN_ID = 777000111;
const TEXTS = STAFF_MESSAGES.connectOrders;

let api;
let db;
let fetch;
let log;

const message = (over = {}) => ({
  message_id: 42,
  text: '/connect_orders',
  chat: { id: GROUP_ID, type: 'supergroup', title: 'Staff' },
  from: { id: ADMIN_ID, is_bot: false, first_name: 'Admin' },
  ...over,
});

const setConfig = (extra = {}) =>
  db.__setRows('service_config', rowsFrom({ ...TEST_CONFIG_ROWS, ...extra }));

const run = (msg = message(), extra = {}) =>
  handleConnectOrders(msg, {
    api,
    db,
    fetch,
    log,
    now: () => ADR_VECTOR.timestamp * 1000,
    nonce: () => ADR_VECTOR.nonce,
    ...extra,
  });

/** Everything that left the bot: replies, Core API calls and log lines. */
const everythingSent = () =>
  JSON.stringify([api.calls, log.entries]) +
  fetch.calls.map((c) => new TextDecoder().decode(c.init.body ?? new Uint8Array())).join('');

beforeEach(() => {
  api = createRecordingApi();
  db = createFakeDb();
  fetch = createFakeFetch(() => ({ status: 200, body: '{"connected":true}' }));
  log = silentLogger();
  setConfig({ bot_username: 'MuniraMarketBot' });
});

describe('parseConnectOrdersCommand', () => {
  it.each([
    ['/connect_orders', { mention: null }],
    ['  /connect_orders  ', { mention: null }],
    ['/connect_orders@MuniraMarketBot', { mention: 'MuniraMarketBot' }],
    ['/connect_orders@other_bot', { mention: 'other_bot' }],
    ['/connect_orders please', { mention: null }],
  ])('parses %j', (text, expected) => {
    expect(parseConnectOrdersCommand(text)).toEqual(expected);
  });

  it.each(['/start', '/connect_ordersX', '/Connect_Orders', 'connect_orders', '', undefined, 7])(
    'ignores %j',
    (text) => {
      expect(parseConnectOrdersCommand(text)).toBeNull();
    },
  );
});

describe('/connect_orders', () => {
  it('connects the group with the sender as the signed actor and confirms in uz+ru', async () => {
    const result = await run();
    expect(result).toEqual({ handled: true, outcome: 'connected' });

    expect(fetch.calls).toHaveLength(1);
    const [{ url, init }] = fetch.calls;
    expect(url).toBe('https://core.example.test/api/v1/internal/telegram/staff-chat/connect');
    expect(init.method).toBe('POST');
    expect(init.headers['X-MM-Actor']).toBe(`tg:${ADMIN_ID}`);
    expect(JSON.parse(new TextDecoder().decode(init.body))).toEqual({
      chat_id: GROUP_ID,
      chat_type: 'supergroup',
    });

    expect(api.calls).toEqual([
      {
        method: 'sendMessage',
        params: {
          chat_id: GROUP_ID,
          text: TEXTS.connected,
          reply_parameters: { message_id: 42, allow_sending_without_reply: true },
        },
      },
    ]);
    expect(TEXTS.connected).toMatch(/Guruh ulandi[\s\S]*\n\nГруппа подключена/);
  });

  it('accepts a basic group and the @mention of this bot, case-insensitively', async () => {
    const result = await run(
      message({ text: '/connect_orders@muniramarketbot', chat: { id: -4001, type: 'group' } }),
    );
    expect(result.outcome).toBe('connected');
    expect(JSON.parse(new TextDecoder().decode(fetch.calls[0].init.body))).toEqual({
      chat_id: -4001,
      chat_type: 'group',
    });
  });

  it('ignores the command addressed to another bot, silently', async () => {
    const result = await run(message({ text: '/connect_orders@other_bot' }));
    expect(result).toEqual({ handled: false, outcome: 'ignored' });
    expect(fetch.calls).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
  });

  it('falls back to getMe for the own username when bot_username is not configured', async () => {
    setConfig();
    api.respond('getMe', () => ({ id: 1, is_bot: true, username: 'MuniraMarketBot' }));
    expect((await run(message({ text: '/connect_orders@other_bot' }))).handled).toBe(false);
    expect((await run(message({ text: '/connect_orders@MuniraMarketBot' }))).outcome).toBe(
      'connected',
    );
  });

  it('treats an @mention as ours when the own username cannot be determined', async () => {
    setConfig();
    api.respond('getMe', () => {
      throw new BotApiError(500, 'Internal');
    });
    expect((await run(message({ text: '/connect_orders@whatever_bot' }))).outcome).toBe(
      'connected',
    );
  });

  it('does not handle other messages', async () => {
    for (const text of ['/start', 'hello', undefined]) {
      expect(await run(message({ text }))).toEqual({ handled: false, outcome: 'ignored' });
    }
    expect(fetch.calls).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
  });

  it('explains in a private chat that it works only in the staff group', async () => {
    const result = await run(message({ chat: { id: ADMIN_ID, type: 'private' } }));
    expect(result).toEqual({ handled: true, outcome: 'group_only' });
    expect(fetch.calls).toHaveLength(0);
    expect(api.calls[0].params).toMatchObject({ chat_id: ADMIN_ID, text: TEXTS.groupOnly });
  });

  it('ignores channels', async () => {
    const result = await run(message({ chat: { id: -100999, type: 'channel' } }));
    expect(result.handled).toBe(false);
    expect(api.calls).toHaveLength(0);
  });

  it.each([
    [
      'an anonymous admin',
      {
        from: { id: GROUP_ANONYMOUS_BOT_ID, is_bot: true, first_name: 'Group' },
        sender_chat: { id: GROUP_ID, type: 'supergroup' },
      },
    ],
    ['GroupAnonymousBot without sender_chat', { from: { id: GROUP_ANONYMOUS_BOT_ID } }],
    ['a channel sender', { sender_chat: { id: -100555, type: 'channel' } }],
  ])('refuses %s and asks for a personal account', async (_label, over) => {
    const result = await run(message(over));
    expect(result).toEqual({ handled: true, outcome: 'anonymous' });
    expect(fetch.calls).toHaveLength(0);
    expect(api.calls[0].params.text).toBe(TEXTS.anonymous);
  });

  it('ignores bots and messages without a sender', async () => {
    expect((await run(message({ from: { id: 5, is_bot: true } }))).handled).toBe(false);
    expect((await run(message({ from: undefined }))).handled).toBe(false);
    expect(fetch.calls).toHaveLength(0);
  });

  it('replies that only an admin can connect on 403, revealing nothing else', async () => {
    fetch.__setHandler(() => ({
      status: 403,
      body: '{"error":{"message":"Admin role required"}}',
    }));
    const result = await run();
    expect(result).toEqual({ handled: true, outcome: 'forbidden' });
    expect(api.calls[0].params.text).toBe(TEXTS.forbidden);
    expect(everythingSent()).not.toMatch(/Admin role required/);
  });

  it.each([
    ['401', () => ({ status: 401, body: '{}' })],
    ['422', () => ({ status: 422, body: '{}' })],
    ['500', () => ({ status: 500, body: 'boom' })],
    ['a network failure', () => Promise.reject(new Error('ECONNRESET'))],
    ['an unexpected body', () => ({ status: 200, body: '{"connected":false}' })],
  ])('replies with the generic failure on %s', async (_label, handler) => {
    fetch.__setHandler(handler);
    const result = await run();
    expect(result).toEqual({ handled: true, outcome: 'failed' });
    expect(api.calls[0].params.text).toBe(TEXTS.failed);
  });

  it('replies with the generic failure when the service config is missing', async () => {
    db.__setRows('service_config', rowsFrom({ bot_username: 'MuniraMarketBot' }));
    expect(await run()).toEqual({ handled: true, outcome: 'failed' });
    expect(fetch.calls).toHaveLength(0);
    expect(api.calls[0].params.text).toBe(TEXTS.failed);
  });

  it('replies with the generic failure when the config cannot be read', async () => {
    db.__failWith(new Error('db down'));
    expect(await run()).toEqual({ handled: true, outcome: 'failed' });
    expect(api.calls[0].params.text).toBe(TEXTS.failed);
  });

  it('never puts the chat id, the secret or the Core API response in replies or logs', async () => {
    fetch.__setHandler(() => ({ status: 500, body: `{"detail":"chat ${GROUP_ID}"}` }));
    await run();
    const visible = JSON.stringify([api.calls.map((c) => c.params.text), log.entries]);
    expect(visible).not.toContain(String(GROUP_ID));
    expect(visible).not.toContain(String(Math.abs(GROUP_ID)));
    expect(visible).not.toContain(ADR_VECTOR.secret);
    expect(visible).not.toContain('detail');
  });

  it('survives a failing reply', async () => {
    api.respond('sendMessage', () => {
      throw new BotApiError(403, 'Forbidden: not enough rights to send text messages');
    });
    await expect(run()).resolves.toEqual({ handled: true, outcome: 'connected' });
    expect(log.entries.some((e) => e.text.includes('reply failed'))).toBe(true);
  });
});
