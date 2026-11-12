import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppBindings, Entrance } from '../../src/http/context.ts';
import type { DrainCounts } from '../../src/scheduler/drain.ts';
import {
  call,
  createTestApp,
  hasDatabase,
  resetDatabase,
  TEST_BOT_TOKEN,
  testDatabase,
} from '../helpers/harness.ts';
import { signedHeaders } from '../unit/security/helpers.ts';

const DRAIN = '/api/v1/internal/scheduler/notifications/drain';
const CLAIM = '/api/v1/internal/telegram/notifications/claim';

type Behaviour = 'ok' | 'network' | number;

/** A fake Bot API behind the injected `fetch`: per chat id, succeed or fail. */
class FakeBotApi {
  readonly sent: Array<{ chat_id: number; text: string; reply_markup?: unknown }> = [];
  readonly urls: string[] = [];
  behaviour = new Map<number, Behaviour>();
  delayMs = 0;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    this.urls.push(url);
    if (!url.startsWith('https://api.telegram.org/bot')) throw new Error('unexpected host');
    const params = JSON.parse(String(init?.body)) as { chat_id: number; text: string };
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const behaviour = this.behaviour.get(params.chat_id) ?? 'ok';
    if (behaviour === 'network') throw new TypeError(`fetch failed for ${url}`);
    if (behaviour === 'ok') {
      this.sent.push(params);
      return Response.json({ ok: true, result: { message_id: this.sent.length } });
    }
    return Response.json(
      { ok: false, error_code: behaviour, description: `secret description ${params.chat_id}` },
      { status: behaviour },
    );
  };
}

describe.skipIf(!hasDatabase)('POST /internal/scheduler/notifications/drain', () => {
  const db = testDatabase()!;
  let now: number;
  let bot: FakeBotApi;
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    await resetDatabase(db);
    now = Math.floor(Date.now() / 1000);
    bot = new FakeBotApi();
    app = createTestApp({ db, clock: () => now, fetch: bot.fetch });
  });

  function drain(
    options: {
      target?: Hono<AppBindings>;
      entrance?: Entrance;
      actor?: string;
      keyId?: string;
    } = {},
  ) {
    const headers = signedHeaders({
      method: 'POST',
      path: DRAIN,
      keyId: options.keyId ?? 'scheduler',
      timestamp: now,
      ...(options.actor ? { actor: options.actor } : {}),
    });
    return call(options.target ?? app, 'POST', DRAIN, {
      headers,
      entrance: options.entrance ?? 'scheduler',
    });
  }

  async function insert(
    chatId: number,
    options: { eventType?: string; payload?: Record<string, unknown>; ageSeconds?: number } = {},
  ): Promise<string> {
    const payload = options.payload ?? {
      order_id: crypto.randomUUID(),
      order_number: `MM-${chatId}`,
      status: 'CONFIRMED',
      locale: 'uz',
      total_uzs: 125000,
      chat_id: chatId,
    };
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO notification_outbox (event_type, payload, created_at, available_at)
       VALUES ($1, $2::jsonb, to_timestamp($3::float8), to_timestamp($3::float8))
       RETURNING id::text AS id`,
      [
        options.eventType ?? 'order.status_changed',
        JSON.stringify(payload),
        now - (options.ageSeconds ?? 10),
      ],
    );
    return rows[0]!.id;
  }

  async function row(id: string) {
    const { rows } = await db.query<{
      attempts: number;
      outcome: string | null;
      last_error: string | null;
      locked: boolean;
      delay: number;
    }>(
      `SELECT attempts, outcome, last_error, locked_until IS NOT NULL AS locked,
              extract(epoch FROM available_at)::float8 - $2 AS delay
       FROM notification_outbox WHERE id = $1`,
      [id, now],
    );
    return rows[0]!;
  }

  async function counts(response: Response) {
    expect(response.status).toBe(200);
    return (await response.json()) as DrainCounts;
  }

  it('delivers due messages and answers with counts only', async () => {
    const a = await insert(1001, { ageSeconds: 20 });
    const b = await insert(1002);
    const staff = await insert(-100500, {
      eventType: 'order.staff_alert',
      payload: {
        order_id: crypto.randomUUID(),
        order_number: 'MM-9',
        status: 'NEW',
        previous_status: null,
        total_uzs: 5000,
        chat_id: -100500,
        cancelled_by_customer: false,
        destination: { lat: 41.311081, lon: 69.240562 },
      },
      ageSeconds: 5,
    });
    const response = await drain();
    const body = await counts(response);
    expect(body).toEqual({
      claimed: 3,
      delivered: 3,
      blocked: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
      report_failed: 0,
    });
    expect(Object.keys(body)).toEqual([
      'claimed',
      'delivered',
      'blocked',
      'retried',
      'failed',
      'skipped',
      'report_failed',
    ]);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(bot.sent.map((m) => m.chat_id)).toEqual([1001, 1002, -100500]);
    // The staff alert carries the Yandex Go courier button; customer messages carry none.
    expect(bot.sent.map((m) => m.reply_markup)).toEqual([
      undefined,
      undefined,
      {
        inline_keyboard: [
          [
            {
              text: 'Yandex chaqirish / Вызвать Яндекс',
              url:
                'https://3.redirect.appmetrica.yandex.com/route?end-lat=41.311081&end-lon=69.240562' +
                '&tariffClass=courier&level=courier&ref=muniramarket' +
                '&appmetrica_tracking_id=1178268795219780156&lang=uz',
            },
          ],
        ],
      },
    ]);
    expect(bot.urls[0]).toBe(`https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`);
    for (const id of [a, b, staff]) {
      expect(await row(id)).toMatchObject({ attempts: 1, outcome: 'delivered', locked: false });
    }
    // Nothing left to do.
    expect((await counts(await drain())).claimed).toBe(0);
  });

  it('records recipient_blocked, failed payloads and unknown events as final', async () => {
    bot.behaviour.set(2001, 403);
    bot.behaviour.set(2002, 400);
    const blocked = await insert(2001);
    const rejected = await insert(2002);
    const invalid = await insert(2003, { payload: { chat_id: 2003 } });
    const unknown = await insert(2004, { eventType: 'order.mystery' });
    const body = await counts(await drain());
    expect(body).toMatchObject({ claimed: 4, delivered: 0, blocked: 1, failed: 3, retried: 0 });
    expect(await row(blocked)).toMatchObject({ outcome: 'recipient_blocked', last_error: null });
    expect(await row(rejected)).toMatchObject({ outcome: 'failed', last_error: 'bot_api_400' });
    expect(await row(invalid)).toMatchObject({ outcome: 'failed', last_error: 'invalid_payload' });
    expect(await row(unknown)).toMatchObject({ outcome: 'failed', last_error: 'unknown_event' });
  });

  it('retries transport errors and Bot API 429/5xx with backoff, never storing the token', async () => {
    bot.behaviour.set(3001, 'network');
    bot.behaviour.set(3002, 429);
    bot.behaviour.set(3003, 502);
    const network = await insert(3001);
    const flood = await insert(3002);
    const server = await insert(3003);
    const body = await counts(await drain());
    expect(body).toMatchObject({ claimed: 3, retried: 3, delivered: 0 });
    expect(await row(network)).toMatchObject({
      outcome: null,
      last_error: 'transport_error',
      locked: false,
      delay: 30,
    });
    expect(await row(flood)).toMatchObject({ outcome: null, last_error: 'bot_api_429', delay: 30 });
    expect(await row(server)).toMatchObject({
      outcome: null,
      last_error: 'bot_api_502',
      delay: 30,
    });
    // Not due again until the backoff ends; then delivered.
    expect((await counts(await drain())).claimed).toBe(0);
    bot.behaviour.clear();
    now += 30;
    expect(await counts(await drain())).toMatchObject({ claimed: 3, delivered: 3 });
    expect(await row(network)).toMatchObject({ attempts: 2, outcome: 'delivered' });
    const { rows } = await db.query(
      "SELECT 1 FROM notification_outbox WHERE last_error LIKE '%TEST-ONLY%'",
    );
    expect(rows).toHaveLength(0);
  });

  it('a stale attempt cannot overwrite the outcome of a reclaimed message', async () => {
    const id = await insert(4001);
    // Worker A claims through the signed route (attempt 1) and then stalls past its lease.
    const claim = await call(app, 'POST', CLAIM, {
      headers: signedHeaders({ method: 'POST', path: CLAIM, timestamp: now }),
    });
    expect(((await claim.json()) as { items: unknown[] }).items).toHaveLength(1);
    // Within the lease the drain leaves it alone.
    expect((await counts(await drain())).claimed).toBe(0);
    now += 61;
    expect(await counts(await drain())).toMatchObject({ claimed: 1, delivered: 1 });
    const path = `/api/v1/internal/telegram/notifications/${id}/result`;
    const body = JSON.stringify({ attempt: 1, outcome: 'retry', error_code: 'late' });
    const late = await call(app, 'POST', path, {
      headers: signedHeaders({ method: 'POST', path, body, timestamp: now }),
      body,
    });
    expect(late.status).toBe(404);
    expect(await row(id)).toMatchObject({ attempts: 2, outcome: 'delivered', last_error: null });
  });

  it('overlapping drains never send a message twice within a lease', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(await insert(5000 + i, { ageSeconds: 30 - i }));
    bot.delayMs = 20;
    const [first, second] = await Promise.all([drain(), drain()]);
    const a = await counts(first);
    const b = await counts(second);
    expect(a.claimed + b.claimed).toBe(6);
    expect(a.delivered + b.delivered).toBe(6);
    expect(bot.sent).toHaveLength(6);
    expect(new Set(bot.sent.map((m) => m.chat_id)).size).toBe(6);
    for (const id of ids)
      expect(await row(id)).toMatchObject({ attempts: 1, outcome: 'delivered' });
  });

  it('leaves undelivered messages claimable after the lease expires', async () => {
    const id = await insert(6001);
    // A drain that died after claiming (no report): simulate with the claim route.
    await call(app, 'POST', CLAIM, {
      headers: signedHeaders({ method: 'POST', path: CLAIM, timestamp: now }),
    });
    expect(await row(id)).toMatchObject({ attempts: 1, locked: true });
    expect((await counts(await drain())).claimed).toBe(0);
    now += 60;
    expect(await counts(await drain())).toMatchObject({ claimed: 1, delivered: 1 });
  });

  it('answers 503 without a bot token and claims nothing', async () => {
    const id = await insert(7001);
    const noToken = createTestApp({
      db,
      clock: () => now,
      fetch: bot.fetch,
      env: { TELEGRAM_BOT_TOKEN: undefined },
    });
    const response = await drain({ target: noToken });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'service_unavailable', message: 'Service temporarily unavailable' },
    });
    expect(await row(id)).toMatchObject({ attempts: 0, locked: false });
    expect(bot.urls).toEqual([]);
  });

  it('exists only on the scheduler entrance, signed, without an actor', async () => {
    const id = await insert(8001);
    for (const entrance of ['public', 'storefront', 'admin'] as const) {
      const response = await drain({ entrance });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not Found' } });
    }
    const unsigned = await call(app, 'POST', DRAIN, { entrance: 'scheduler' });
    expect(unsigned.status).toBe(401);
    const withActor = await drain({ actor: 'tg:1' });
    expect(withActor.status).toBe(403);
    expect(await row(id)).toMatchObject({ attempts: 0 });
    // Any configured service key works; the gateway uses the `scheduler` one.
    expect((await counts(await drain({ keyId: 'tg' }))).delivered).toBe(1);
  });
});
