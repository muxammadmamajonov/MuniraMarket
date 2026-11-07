import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULER_KEY_ID,
  type LogFn,
  SCHEDULER_BASE_URL,
  isCleanupTick,
  runScheduledTick,
  selectSigningKey,
} from '../src/scheduler';
import type { FetchFn } from '../src/botApi';
import { isAllowed } from '../src/routing';

// Test-only values; not real credentials.
const SECRET = 'test-only-scheduler-secret-0123456789abcdef';
const OTHER_SECRET = 'test-only-other-secret-0123456789abcdefgh';
const TOKEN = '123456789:TEST_ONLY_token_not_real_aaaaaaaaaaaaaa';
const KEYS = `telegram:${OTHER_SECRET},scheduler:${SECRET}`;

const T0 = Date.parse('2026-11-06T10:01:00Z'); // minute 1: no cleanup
const T15 = Date.parse('2026-11-06T10:15:00Z'); // minute 15: cleanup
const ID1 = '0b6f3f6e-6a8c-4a47-9d0e-3b1f2c4d5e61';
const ID2 = '0b6f3f6e-6a8c-4a47-9d0e-3b1f2c4d5e62';

describe('selectSigningKey', () => {
  it('picks the configured key id (default "scheduler")', () => {
    expect(selectSigningKey(KEYS, undefined)).toEqual({
      ok: true,
      keyId: DEFAULT_SCHEDULER_KEY_ID,
      secret: SECRET,
    });
    expect(selectSigningKey(KEYS, '')).toMatchObject({ ok: true, keyId: 'scheduler' });
    expect(selectSigningKey(KEYS, 'telegram')).toEqual({
      ok: true,
      keyId: 'telegram',
      secret: OTHER_SECRET,
    });
    expect(selectSigningKey(` scheduler:${SECRET} , x:${OTHER_SECRET}`, 'scheduler')).toMatchObject(
      {
        ok: true,
        secret: SECRET,
      },
    );
  });

  it('keeps colons inside the secret, like the Core API parser', () => {
    expect(selectSigningKey(`scheduler:${SECRET}:tail`, undefined)).toMatchObject({
      secret: `${SECRET}:tail`,
    });
  });

  it.each([
    [undefined, undefined, 'keys_missing'],
    ['', undefined, 'keys_missing'],
    ['  ', undefined, 'keys_missing'],
    [`telegram:${OTHER_SECRET}`, undefined, 'key_not_found'],
    ['scheduler', undefined, 'key_not_found'],
    ['scheduler:short', undefined, 'secret_too_short'],
    [`scheduler:${'é'.repeat(15)}`, undefined, 'secret_too_short'],
    [KEYS, 'bad key!', 'key_id_invalid'],
    [KEYS, 'x'.repeat(33), 'key_id_invalid'],
  ])('fails closed for %j / %j (%s)', (keys, keyId, reason) => {
    const result = selectSigningKey(keys, keyId);
    expect(result).toEqual({ ok: false, reason });
    // Only the reason: never a key id from the list or any part of a secret.
    expect(Object.keys(result).sort()).toEqual(['ok', 'reason']);
  });
});

describe('isCleanupTick', () => {
  it.each([
    ['2026-11-06T10:00:00Z', true],
    ['2026-11-06T10:15:00Z', true],
    ['2026-11-06T10:30:00Z', true],
    ['2026-11-06T10:45:59Z', true],
    ['2026-11-06T10:01:00Z', false],
    ['2026-11-06T10:14:00Z', false],
    ['2026-11-06T10:59:00Z', false],
  ])('%s -> %s', (time, expected) => {
    expect(isCleanupTick(Date.parse(time))).toBe(expected);
  });

  it('is false for a non-finite time', () => {
    expect(isCleanupTick(Number.NaN)).toBe(false);
  });
});

/** Re-derives the ADR 0003 signature from what reached the container. */
async function verifySignature(request: Request): Promise<boolean> {
  const url = new URL(request.url);
  const body = new Uint8Array(await request.clone().arrayBuffer());
  const h = request.headers;
  const canonical = [
    'MM-SVC-V1',
    h.get('x-mm-key-id'),
    h.get('x-mm-timestamp'),
    h.get('x-mm-nonce'),
    request.method,
    url.pathname + url.search,
    h.get('x-mm-actor') ?? '',
    createHash('sha256').update(body).digest('hex'),
  ].join('\n');
  return createHmac('sha256', SECRET).update(canonical).digest('hex') === h.get('x-mm-signature');
}

interface Harness {
  forwarded: {
    method: string;
    path: string;
    actor: string | null;
    signed: boolean;
    body: string;
  }[];
  botCalls: { url: string; body: unknown }[];
  logs: { level: string; message: string; fields?: Record<string, unknown> }[];
  log: LogFn;
  forward: (request: Request) => Promise<Response>;
  fetch: FetchFn;
}

function harness(
  options: {
    items?: unknown[];
    claim?: () => Response | Promise<Response>;
    cleanup?: () => Response | Promise<Response>;
    bot?: () => Response | Promise<Response>;
  } = {},
): Harness {
  const h: Harness = {
    forwarded: [],
    botCalls: [],
    logs: [],
    log: (level, message, fields) => {
      h.logs.push(fields === undefined ? { level, message } : { level, message, fields });
    },
    async forward(request) {
      const url = new URL(request.url);
      expect(url.origin).toBe(SCHEDULER_BASE_URL);
      // The real forward() applies the scheduler allow-list; every request must pass it.
      expect(isAllowed('scheduler', request.method, url.pathname)).toBe(true);
      h.forwarded.push({
        method: request.method,
        path: url.pathname,
        actor: request.headers.get('x-mm-actor'),
        signed: await verifySignature(request),
        body: await request.clone().text(),
      });
      if (url.pathname.endsWith('/claim')) {
        return options.claim
          ? options.claim()
          : Response.json({
              items: options.items ?? [],
              lease_expires_at: new Date(T0 + 60_000).toISOString(),
            });
      }
      if (url.pathname.endsWith('/cleanup')) {
        return options.cleanup ? options.cleanup() : new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    },
    async fetch(url, init) {
      h.botCalls.push({ url, body: JSON.parse(String(init.body)) });
      return options.bot ? options.bot() : Response.json({ ok: true, result: { message_id: 1 } });
    },
  };
  return h;
}

const env = (over: Record<string, string | undefined> = {}) => ({
  SERVICE_AUTH_KEYS: KEYS,
  SCHEDULER_SERVICE_KEY_ID: 'scheduler',
  TELEGRAM_BOT_TOKEN: TOKEN,
  ...over,
});

const items = [
  {
    id: ID1,
    event_type: 'order.status_changed',
    attempts: 1,
    payload: {
      order_id: ID1,
      order_number: '261106-AB12CD',
      status: 'CONFIRMED',
      locale: 'ru',
      total_uzs: 50000,
      chat_id: 555,
    },
  },
  {
    id: ID2,
    event_type: 'order.staff_alert',
    attempts: 2,
    payload: {
      order_id: ID1,
      order_number: '261106-AB12CD',
      status: 'NEW',
      previous_status: null,
      total_uzs: 50000,
      chat_id: -1001234567890,
      cancelled_by_customer: false,
    },
  },
];

function tick(h: Harness, scheduledTime: number, over: Record<string, string | undefined> = {}) {
  return runScheduledTick({
    env: env(over),
    scheduledTime,
    forward: h.forward,
    fetch: h.fetch,
    log: h.log,
    now: () => (scheduledTime === T15 ? T0 : scheduledTime),
  });
}

/** Nothing secret may ever reach a log line. */
function expectCleanLogs(h: Harness) {
  const text = JSON.stringify(h.logs);
  for (const secret of [SECRET, OTHER_SECRET, TOKEN, 'api.telegram.org', '555', '1001234567890']) {
    expect(text).not.toContain(secret);
  }
}

describe('runScheduledTick', () => {
  it('drains the outbox through the scheduler entrance, signed with an empty actor', async () => {
    const h = harness({ items });
    await expect(tick(h, T0)).resolves.toEqual({ drain: 'ok', cleanup: 'not_due' });

    expect(h.forwarded.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/v1/internal/telegram/notifications/claim',
      `POST /api/v1/internal/telegram/notifications/${ID1}/result`,
      `POST /api/v1/internal/telegram/notifications/${ID2}/result`,
    ]);
    for (const request of h.forwarded) {
      expect(request.signed).toBe(true);
      expect(request.actor).toBe('');
    }
    expect(JSON.parse(h.forwarded[0]?.body ?? '')).toEqual({ limit: 20 });
    expect(JSON.parse(h.forwarded[1]?.body ?? '')).toEqual({ attempt: 1, outcome: 'delivered' });
    expect(JSON.parse(h.forwarded[2]?.body ?? '')).toEqual({ attempt: 2, outcome: 'delivered' });

    expect(h.botCalls.map((c) => (c.body as { chat_id: number }).chat_id)).toEqual([
      555, -1001234567890,
    ]);
    expect(h.botCalls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(h.logs).toEqual([
      expect.objectContaining({ level: 'info', message: 'scheduler: outbox drained' }),
    ]);
    expectCleanLogs(h);
  });

  it('drains on every tick and cleans up only on 15-minute ticks', async () => {
    const h = harness();
    for (let minute = 0; minute < 31; minute += 1) {
      await tick(h, Date.parse('2026-11-06T10:00:00Z') + minute * 60_000);
    }
    const claims = h.forwarded.filter((r) => r.path.endsWith('/claim'));
    const cleanups = h.forwarded.filter((r) => r.path.endsWith('/cleanup'));
    expect(claims).toHaveLength(31);
    expect(cleanups).toHaveLength(3); // minutes 0, 15, 30
    for (const request of cleanups) {
      expect(request.signed).toBe(true);
      expect(request.actor).toBe('');
      expect(request.body).toBe('');
    }
  });

  it('runs the cleanup after the drain on a 15-minute tick', async () => {
    const h = harness();
    await expect(tick(h, T15)).resolves.toEqual({ drain: 'ok', cleanup: 'ok' });
    expect(h.forwarded.map((r) => r.path)).toEqual([
      '/api/v1/internal/telegram/notifications/claim',
      '/api/v1/internal/maintenance/cleanup',
    ]);
  });

  it('fails closed without a usable signing key: no request at all', async () => {
    for (const over of [
      { SERVICE_AUTH_KEYS: undefined },
      { SERVICE_AUTH_KEYS: `telegram:${OTHER_SECRET}` },
      { SERVICE_AUTH_KEYS: 'scheduler:too-short' },
      { SCHEDULER_SERVICE_KEY_ID: 'no such key!' },
    ]) {
      const h = harness();
      await expect(tick(h, T15, over)).resolves.toEqual({ drain: 'skipped', cleanup: 'skipped' });
      expect(h.forwarded).toHaveLength(0);
      expect(h.botCalls).toHaveLength(0);
      expect(h.logs).toEqual([
        {
          level: 'error',
          message: 'scheduler: signing key unavailable, tick skipped',
          fields: { reason: expect.any(String) },
        },
      ]);
      expectCleanLogs(h);
    }
  });

  it('skips the drain but still cleans up without a bot token', async () => {
    const h = harness({ items });
    await expect(tick(h, T15, { TELEGRAM_BOT_TOKEN: '' })).resolves.toEqual({
      drain: 'skipped',
      cleanup: 'ok',
    });
    expect(h.forwarded.map((r) => r.path)).toEqual(['/api/v1/internal/maintenance/cleanup']);
    expect(h.logs[0]).toMatchObject({ level: 'error' });
  });

  it('swallows and logs a failed claim (status and code only), then still cleans up', async () => {
    const h = harness({
      claim: () => Response.json({ detail: `secret ${SECRET}` }, { status: 503 }),
    });
    await expect(tick(h, T15)).resolves.toEqual({ drain: 'failed', cleanup: 'ok' });
    expect(h.logs).toContainEqual({
      level: 'error',
      message: 'scheduler: outbox drain failed',
      fields: { error: 'CoreApiError', status: 503, code: 'UPSTREAM_ERROR' },
    });
    expectCleanLogs(h);
  });

  it('swallows a forward() that throws, and a failed cleanup', async () => {
    const h = harness({
      claim: () => {
        throw new Error(`boom ${SECRET}`);
      },
      cleanup: () => new Response('nope', { status: 401 }),
    });
    await expect(tick(h, T15)).resolves.toEqual({ drain: 'failed', cleanup: 'failed' });
    expect(h.logs).toEqual([
      {
        level: 'error',
        message: 'scheduler: outbox drain failed',
        fields: { error: 'CoreApiError', status: 0, code: 'NETWORK_ERROR' },
      },
      {
        level: 'error',
        message: 'scheduler: cleanup failed',
        fields: { error: 'CoreApiError', status: 401, code: 'UNAUTHORIZED' },
      },
    ]);
    expectCleanLogs(h);
  });

  it('reports Bot API failures to the outbox without leaking the token', async () => {
    const h = harness({
      items,
      bot: () =>
        Response.json(
          { ok: false, error_code: 403, description: `Forbidden ${TOKEN}` },
          { status: 403 },
        ),
    });
    await expect(tick(h, T0)).resolves.toEqual({ drain: 'ok', cleanup: 'not_due' });
    expect(JSON.parse(h.forwarded[1]?.body ?? '')).toEqual({
      attempt: 1,
      outcome: 'recipient_blocked',
    });
    expect(JSON.parse(h.forwarded[2]?.body ?? '')).toEqual({
      attempt: 2,
      outcome: 'recipient_blocked',
    });
    for (const request of h.forwarded) expect(request.body).not.toContain(TOKEN);
    expectCleanLogs(h);
  });
});
