import { beforeEach, describe, expect, it } from 'vitest';
import { handleContact } from '../tgcloud/lib/bot/contact.js';
import { handleCallbackQuery, parseLanguageCallback } from '../tgcloud/lib/bot/onboarding.js';
import { buildLanguageKeyboard, handleMessage } from '../tgcloud/lib/bot/start.js';
import { BotApiError, createRecordingApi } from './sdk-fake/api.js';
import { createFakeDb } from './sdk-fake/db.js';
import { createFakeFetch } from './sdk-fake/fetch.js';
import { ADR_VECTOR, TEST_CONFIG_ROWS, rowsFrom, silentLogger } from './helpers.js';

const PHONE = '+998901234567';
let api;
let db;
let fetch;
let log;

const user = (over = {}) =>
  JSON.stringify({
    user: {
      telegram_user_id: 555,
      language: 'uz',
      language_confirmed: true,
      phone_verified: false,
      ...over,
    },
  });

const deps = () => ({
  api,
  db,
  fetch,
  log,
  now: () => ADR_VECTOR.timestamp * 1000,
  nonce: () => ADR_VECTOR.nonce,
});

const start = (text = '/start') =>
  handleMessage(
    {
      message_id: 1,
      text,
      chat: { id: 555, type: 'private' },
      from: { id: 555, first_name: 'Munira', language_code: 'ru' },
    },
    deps(),
  );

beforeEach(() => {
  api = createRecordingApi();
  db = createFakeDb();
  db.__setRows(
    'service_config',
    rowsFrom({ ...TEST_CONFIG_ROWS, mini_app_url: 'https://app.example.test/' }),
  );
  fetch = createFakeFetch(() => ({ body: user() }));
  log = silentLogger();
});

describe('first /start language choice', () => {
  it('asks once, in both languages, when the language was never chosen', async () => {
    fetch.__setHandler(() => ({ body: user({ language_confirmed: false }) }));
    const result = await start();
    expect(result).toEqual({ handled: true, button: 'language' });
    const sent = api.calls[0].params;
    expect(sent.text).toContain('Munira');
    expect(sent.text).toContain('Qaysi tilda');
    expect(sent.text).toContain('На каком языке');
    expect(sent.reply_markup).toEqual(buildLanguageKeyboard(null));
  });

  it('greets in the SAVED language (not the Telegram app language) once chosen', async () => {
    const result = await start();
    expect(result.button).toBe('web_app');
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].params.text).toMatch(/^Assalomu alaykum, Munira!/);
    expect(api.calls[0].params.reply_markup.inline_keyboard[0][0]).toEqual({
      text: 'Do‘konni ochish',
      web_app: { url: 'https://app.example.test/' },
    });
  });

  it('falls back to the Telegram language when the Core API is down (never asks blindly)', async () => {
    fetch.__setHandler(() => ({ status: 503, body: 'nope' }));
    const result = await start();
    expect(result.button).toBe('web_app');
    expect(api.calls[0].params.text).toMatch(/^Здравствуйте, Munira!/);
  });

  it('carries a short start payload through the buttons', () => {
    expect(buildLanguageKeyboard('phone').inline_keyboard[0][1].callback_data).toBe(
      'lang:ru:phone',
    );
    expect(buildLanguageKeyboard('x'.repeat(60)).inline_keyboard[0][0].callback_data).toBe(
      'lang:uz',
    );
  });

  it.each([
    ['lang:uz', { language: 'uz', payload: null }],
    ['lang:ru:phone', { language: 'ru', payload: 'phone' }],
    ['lang:en', null],
    ['lang:uz:bad payload', null],
    [42, null],
  ])('parses callback %j', (data, expected) => {
    expect(parseLanguageCallback(data)).toEqual(expected);
  });
});

describe('language button', () => {
  const query = (data = 'lang:ru') => ({
    id: 'cbq-1',
    data,
    from: { id: 555, first_name: 'Munira' },
    message: { message_id: 9, chat: { id: 555, type: 'private' } },
  });

  it('saves the choice through the signed Core API, confirms and greets in that language', async () => {
    fetch.__setHandler(() => ({ body: user({ language: 'ru' }) }));
    const result = await handleCallbackQuery(query(), deps());
    expect(result).toEqual({ handled: true, saved: true });
    expect(fetch.calls[0].url).toBe('https://core.example.test/api/v1/internal/telegram/language');
    expect(fetch.calls[0].init.method).toBe('PUT');
    expect(fetch.calls[0].init.headers['X-MM-Actor']).toBe('tg:555');
    expect(new TextDecoder().decode(fetch.calls[0].init.body)).toBe('{"language":"ru"}');
    const methods = api.calls.map((call) => call.method);
    expect(methods).toEqual(['answerCallbackQuery', 'editMessageText', 'sendMessage']);
    expect(api.calls[1].params.text).toContain('русский');
    expect(api.calls[2].params.text).toMatch(/^Здравствуйте, Munira!/);
  });

  it('goes on to the phone request when the deep link asked for it', async () => {
    fetch.__setHandler(() => ({ body: user({ language: 'uz' }) }));
    await handleCallbackQuery(query('lang:uz:phone'), deps());
    const last = api.calls.at(-1).params;
    expect(last.reply_markup.keyboard[0][0]).toEqual({
      text: 'Raqamimni yuborish',
      request_contact: true,
    });
  });

  it('tells the user when saving failed and keeps the buttons', async () => {
    fetch.__setHandler(() => ({ status: 500, body: 'boom' }));
    const result = await handleCallbackQuery(query(), deps());
    expect(result).toEqual({ handled: true, saved: false });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].method).toBe('answerCallbackQuery');
    expect(api.calls[0].params.text).toBeTruthy();
  });

  it('ignores unrelated callbacks and group chats', async () => {
    expect(await handleCallbackQuery(query('other'), deps())).toEqual({ handled: false });
    const group = { ...query(), message: { message_id: 1, chat: { id: -100, type: 'group' } } };
    expect(await handleCallbackQuery(group, deps())).toEqual({ handled: false });
    expect(api.calls).toHaveLength(0);
  });
});

describe('/start phone and shared contacts', () => {
  const contactMessage = (contact) => ({
    message_id: 3,
    chat: { id: 555, type: 'private' },
    from: { id: 555, first_name: 'Munira', language_code: 'uz' },
    contact,
  });

  it('/start phone asks for the own number with a request_contact button', async () => {
    await start('/start phone');
    expect(api.calls[0].params.reply_markup.keyboard[0][0].request_contact).toBe(true);
  });

  it('/start phone just greets when the number is already verified', async () => {
    fetch.__setHandler(() => ({ body: user({ phone_verified: true }) }));
    await start('/start phone');
    expect(api.calls[0].params.reply_markup.inline_keyboard).toBeDefined();
  });

  it('stores only the sender’s own contact and never logs the number', async () => {
    const logged = [];
    log = {
      log: (...a) => logged.push(a),
      warn: (...a) => logged.push(a),
      error: (...a) => logged.push(a),
    };
    fetch.__setHandler(() => ({ body: user({ phone_verified: true }) }));
    const result = await handleContact(
      contactMessage({ user_id: 555, phone_number: PHONE, first_name: 'Munira' }),
      deps(),
    );
    expect(result).toEqual({ handled: true, verified: true });
    expect(fetch.calls[0].url).toBe('https://core.example.test/api/v1/internal/telegram/phone');
    expect(JSON.parse(new TextDecoder().decode(fetch.calls[0].init.body))).toEqual({
      contact_user_id: 555,
      phone_number: PHONE,
    });
    expect(api.calls.map((call) => call.method)).toEqual(['deleteMessage', 'sendMessage']);
    expect(api.calls[0].params).toEqual({ chat_id: 555, message_id: 3 });
    expect(api.calls[1].params.reply_markup).toEqual({ remove_keyboard: true });
    expect(JSON.stringify(logged)).not.toContain('998');
    expect(JSON.stringify(api.calls)).not.toContain('901234567');
  });

  it('still confirms when the shared contact message cannot be deleted', async () => {
    const warnings = [];
    log = { ...silentLogger(), warn: (...a) => warnings.push(a) };
    fetch.__setHandler(() => ({ body: user({ phone_verified: true }) }));
    api.respond('deleteMessage', () => {
      throw new BotApiError(400, "Bad Request: message can't be deleted", {
        method: 'deleteMessage',
      });
    });
    const result = await handleContact(
      contactMessage({ user_id: 555, phone_number: PHONE, first_name: 'Munira' }),
      deps(),
    );
    expect(result).toEqual({ handled: true, verified: true });
    expect(api.calls.map((call) => call.method)).toEqual(['deleteMessage', 'sendMessage']);
    expect(api.calls[1].params.reply_markup).toEqual({ remove_keyboard: true });
    expect(warnings).toEqual([
      ['contact: shared contact message not deleted:', 'BotApiError code=400'],
    ]);
    expect(JSON.stringify(warnings)).not.toContain('998');
  });

  it('keeps the contact message when the number was not saved', async () => {
    fetch.__setHandler(() => ({ status: 503, body: '{}' }));
    const result = await handleContact(
      contactMessage({ user_id: 555, phone_number: PHONE, first_name: 'Munira' }),
      deps(),
    );
    expect(result).toEqual({ handled: true, verified: false });
    expect(api.calls.map((call) => call.method)).toEqual(['sendMessage']);
  });

  it('refuses someone else’s contact without calling the Core API', async () => {
    const result = await handleContact(
      contactMessage({ user_id: 777, phone_number: PHONE, first_name: 'Other' }),
      deps(),
    );
    expect(result).toEqual({ handled: true, verified: false });
    expect(fetch.calls).toHaveLength(0);
  });

  it('a contact without user_id (typed manually) is not the user’s own', async () => {
    await handleContact(contactMessage({ phone_number: PHONE, first_name: 'X' }), deps());
    expect(fetch.calls).toHaveLength(0);
  });
});
