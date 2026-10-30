import { describe, expect, it } from 'vitest';
import { CoreApiError } from '../tgcloud/lib/coreApi/errors.js';
import {
  LEASE_MS,
  LEASE_SAFETY_MARGIN_MS,
  drainOrderNotifications,
  parseOrderStatusPayload,
} from '../tgcloud/lib/notifications/outbox.js';

const T0 = Date.parse('2026-10-31T10:00:00Z');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payload = (extra = {}) => ({
  order_id: uuid(900),
  order_number: '261031-7KQ2MX',
  status: 'CONFIRMED',
  locale: 'uz',
  total_uzs: 125000,
  chat_id: 555,
  ...extra,
});
const message = (n, extra = {}) => ({
  id: uuid(n),
  event_type: 'order.status_changed',
  payload: payload(),
  attempts: 0,
  ...extra,
});

/** Fake Core API: `batches` are served one per claim; reports are recorded. */
function createCoreApi({ batches, leaseMs = LEASE_MS, reportError } = {}) {
  const queue = [...batches];
  const claims = [];
  const reports = [];
  return {
    claims,
    reports,
    async claimNotifications(options) {
      claims.push(options);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return {
        items: next ?? [],
        lease_expires_at: new Date(T0 + leaseMs).toISOString(),
      };
    },
    async reportNotification(id, result) {
      reports.push({ id, ...result });
      if (reportError) {
        const error = reportError(id, result);
        if (error) throw error;
      }
      return null;
    },
  };
}

function createTransport(outcomeFor = () => ({ outcome: 'delivered' })) {
  const delivered = [];
  return {
    delivered,
    async deliver(notification) {
      delivered.push(notification);
      return outcomeFor(notification, delivered.length);
    },
  };
}

describe('parseOrderStatusPayload', () => {
  it('maps a valid payload to a transport notification', () => {
    expect(parseOrderStatusPayload(payload())).toEqual({
      chatId: 555,
      orderNumber: '261031-7KQ2MX',
      status: 'CONFIRMED',
      locale: 'uz',
      totalUzs: 125000,
    });
    expect(
      parseOrderStatusPayload(payload({ status: 'CANCELLED', cancel_reason: 'Out of stock' })),
    ).toMatchObject({ status: 'CANCELLED', cancelReason: 'Out of stock' });
  });

  it('ignores unknown extra keys', () => {
    expect(parseOrderStatusPayload(payload({ future_field: { a: 1 } }))).not.toBeNull();
  });

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'x'],
    ['missing order_id', payload({ order_id: undefined })],
    ['bad order_id', payload({ order_id: 'not-a-uuid' })],
    ['missing order_number', payload({ order_number: undefined })],
    ['empty order_number', payload({ order_number: '' })],
    ['long order_number', payload({ order_number: 'A'.repeat(33) })],
    ['numeric order_number', payload({ order_number: 7 })],
    ['unknown status', payload({ status: 'SHIPPED' })],
    ['lowercase status', payload({ status: 'new' })],
    ['unknown locale', payload({ locale: 'en' })],
    ['missing locale', payload({ locale: undefined })],
    ['string total', payload({ total_uzs: '100' })],
    ['fractional total', payload({ total_uzs: 1.5 })],
    ['negative total', payload({ total_uzs: -1 })],
    ['missing total', payload({ total_uzs: undefined })],
    ['string chat_id', payload({ chat_id: '555' })],
    ['zero chat_id', payload({ chat_id: 0 })],
    ['negative chat_id', payload({ chat_id: -100 })],
    ['unsafe chat_id', payload({ chat_id: 2 ** 53 })],
    ['null cancel_reason', payload({ cancel_reason: null })],
    ['numeric cancel_reason', payload({ cancel_reason: 5 })],
  ])('rejects %s', (_name, value) => {
    expect(parseOrderStatusPayload(value)).toBeNull();
  });
});

describe('drainOrderNotifications', () => {
  it('claims with the limit, delivers sequentially and reports every outcome', async () => {
    const coreApi = createCoreApi({
      batches: [[message(1), message(2), message(3), message(4)]],
    });
    const order = [];
    const transport = {
      async deliver(n) {
        order.push(`start:${n.chatId}`);
        await Promise.resolve();
        order.push(`end:${n.chatId}`);
        return [
          { outcome: 'delivered' },
          { outcome: 'recipient_blocked' },
          { outcome: 'retry', errorCode: 'bot_api_429' },
          { outcome: 'failed', errorCode: 'bot_api_400' },
        ][order.length / 2 - 1];
      },
    };
    const summary = await drainOrderNotifications({ coreApi, transport, limit: 25, now: () => T0 });
    expect(coreApi.claims).toEqual([{ limit: 25 }]);
    expect(order).toEqual(Array(4).fill(['start:555', 'end:555']).flat());
    expect(coreApi.reports).toEqual([
      { id: uuid(1), outcome: 'delivered' },
      { id: uuid(2), outcome: 'recipient_blocked' },
      { id: uuid(3), outcome: 'retry', errorCode: 'bot_api_429' },
      { id: uuid(4), outcome: 'failed', errorCode: 'bot_api_400' },
    ]);
    expect(summary).toEqual({
      claimed: 4,
      delivered: 1,
      blocked: 1,
      retried: 1,
      failed: 1,
      skipped: 0,
      reportFailed: 0,
    });
  });

  it('passes the parsed notification to the transport', async () => {
    const coreApi = createCoreApi({
      batches: [
        [message(1, { payload: payload({ status: 'CANCELLED', cancel_reason: 'No stock' }) })],
      ],
    });
    const transport = createTransport();
    await drainOrderNotifications({ coreApi, transport, now: () => T0 });
    expect(transport.delivered).toEqual([
      {
        chatId: 555,
        orderNumber: '261031-7KQ2MX',
        status: 'CANCELLED',
        locale: 'uz',
        totalUzs: 125000,
        cancelReason: 'No stock',
      },
    ]);
  });

  it('defaults to limit 20 and a single batch', async () => {
    const coreApi = createCoreApi({
      batches: [Array.from({ length: 20 }, (_, i) => message(i + 1)), [message(99)]],
    });
    const summary = await drainOrderNotifications({
      coreApi,
      transport: createTransport(),
      now: () => T0,
    });
    expect(coreApi.claims).toEqual([{ limit: 20 }]);
    expect(summary.claimed).toBe(20);
  });

  it('reports unknown events as failed/unknown_event without calling the transport', async () => {
    const coreApi = createCoreApi({
      batches: [
        [message(1, { event_type: 'order.refunded' }), message(2, { event_type: undefined })],
      ],
    });
    const transport = createTransport();
    const summary = await drainOrderNotifications({ coreApi, transport, now: () => T0 });
    expect(transport.delivered).toHaveLength(0);
    expect(coreApi.reports).toEqual([
      { id: uuid(1), outcome: 'failed', errorCode: 'unknown_event' },
      { id: uuid(2), outcome: 'failed', errorCode: 'unknown_event' },
    ]);
    expect(summary).toMatchObject({ claimed: 2, failed: 2, delivered: 0 });
  });

  it('reports malformed payloads as failed/invalid_payload and keeps going', async () => {
    const coreApi = createCoreApi({
      batches: [
        [
          message(1, { payload: payload({ status: 'SHIPPED' }) }),
          message(2, { payload: null }),
          message(3),
        ],
      ],
    });
    const transport = createTransport();
    const summary = await drainOrderNotifications({ coreApi, transport, now: () => T0 });
    expect(coreApi.reports).toEqual([
      { id: uuid(1), outcome: 'failed', errorCode: 'invalid_payload' },
      { id: uuid(2), outcome: 'failed', errorCode: 'invalid_payload' },
      { id: uuid(3), outcome: 'delivered' },
    ]);
    expect(transport.delivered).toHaveLength(1);
    expect(summary).toMatchObject({ claimed: 3, delivered: 1, failed: 2 });
  });

  it('skips items without a usable id (cannot be reported)', async () => {
    const coreApi = createCoreApi({
      batches: [
        [{ id: 'nope', event_type: 'order.status_changed', payload: payload() }, null, message(3)],
      ],
    });
    const summary = await drainOrderNotifications({
      coreApi,
      transport: createTransport(),
      now: () => T0,
    });
    expect(coreApi.reports.map((r) => r.id)).toEqual([uuid(3)]);
    expect(summary).toMatchObject({ claimed: 3, delivered: 1, skipped: 2 });
  });

  it('treats a throwing or malformed transport result as retry/transport_error', async () => {
    const coreApi = createCoreApi({ batches: [[message(1), message(2), message(3)]] });
    const results = [
      () => {
        throw new Error('boom with user data 555');
      },
      () => ({ outcome: 'sent' }),
      () => ({ outcome: 'retry', errorCode: 'Not A Code 555' }),
    ];
    const transport = { deliver: async () => results.shift()() };
    const summary = await drainOrderNotifications({ coreApi, transport, now: () => T0 });
    expect(coreApi.reports).toEqual([
      { id: uuid(1), outcome: 'retry', errorCode: 'transport_error' },
      { id: uuid(2), outcome: 'retry', errorCode: 'transport_error' },
      { id: uuid(3), outcome: 'retry' },
    ]);
    expect(summary.retried).toBe(3);
  });

  describe('lease handling', () => {
    it('stops delivering once less than 10 s of the lease remain and leaves the rest', async () => {
      const coreApi = createCoreApi({
        batches: [[message(1), message(2), message(3), message(4)]],
      });
      let clock = T0;
      const transport = createTransport(() => {
        // Each delivery takes 30 s of the 60 s lease.
        clock += 30_000;
        return { outcome: 'delivered' };
      });
      const summary = await drainOrderNotifications({ coreApi, transport, now: () => clock });
      // t=0: 60 s left -> deliver #1; t=30 s: 30 s left -> deliver #2; t=60 s: 0 s left -> stop.
      expect(transport.delivered).toHaveLength(2);
      expect(coreApi.reports.map((r) => r.id)).toEqual([uuid(1), uuid(2)]);
      expect(summary).toEqual({
        claimed: 4,
        delivered: 2,
        blocked: 0,
        retried: 0,
        failed: 0,
        skipped: 2,
        reportFailed: 0,
      });
    });

    it('uses the exact 10 s margin: 10 s left still delivers, 9.999 s does not', async () => {
      for (const [elapsed, expected] of [
        [LEASE_MS - LEASE_SAFETY_MARGIN_MS, 1],
        [LEASE_MS - LEASE_SAFETY_MARGIN_MS + 1, 0],
      ]) {
        const coreApi = createCoreApi({ batches: [[message(1)]] });
        const transport = createTransport();
        let calls = 0;
        // The first `now()` is the claim time (T0); later reads are `elapsed` later.
        const now = () => (calls++ === 0 ? T0 : T0 + elapsed);
        const summary = await drainOrderNotifications({ coreApi, transport, now });
        expect(transport.delivered).toHaveLength(expected);
        expect(summary.skipped).toBe(1 - expected);
      }
    });

    it('does not claim another batch after hitting the cutoff', async () => {
      const coreApi = createCoreApi({
        batches: [
          [message(1), message(2)],
          [message(3), message(4)],
        ],
      });
      let clock = T0;
      const transport = createTransport(() => {
        clock += 55_000;
        return { outcome: 'delivered' };
      });
      const summary = await drainOrderNotifications({
        coreApi,
        transport,
        limit: 2,
        maxBatches: 3,
        now: () => clock,
      });
      expect(coreApi.claims).toHaveLength(1);
      expect(summary).toMatchObject({ claimed: 2, delivered: 1, skipped: 1 });
    });

    it('does not trust a lease_expires_at further away than the nominal lease', async () => {
      const coreApi = createCoreApi({ batches: [[message(1), message(2)]], leaseMs: 10 * 60_000 });
      let clock = T0;
      const transport = createTransport(() => {
        clock += 55_000;
        return { outcome: 'delivered' };
      });
      const summary = await drainOrderNotifications({ coreApi, transport, now: () => clock });
      expect(summary).toMatchObject({ delivered: 1, skipped: 1 });
    });

    it('honours a lease_expires_at earlier than the nominal lease', async () => {
      const coreApi = createCoreApi({ batches: [[message(1), message(2)]], leaseMs: 15_000 });
      let clock = T0;
      const transport = createTransport(() => {
        clock += 6_000;
        return { outcome: 'delivered' };
      });
      const summary = await drainOrderNotifications({ coreApi, transport, now: () => clock });
      expect(summary).toMatchObject({ delivered: 1, skipped: 1 });
    });

    it('falls back to the nominal lease when lease_expires_at is unparseable', async () => {
      const coreApi = createCoreApi({ batches: [[message(1)]] });
      const original = coreApi.claimNotifications;
      coreApi.claimNotifications = async (o) => ({
        ...(await original(o)),
        lease_expires_at: 'garbage',
      });
      const summary = await drainOrderNotifications({
        coreApi,
        transport: createTransport(),
        now: () => T0,
      });
      expect(summary.delivered).toBe(1);
    });
  });

  describe('report failures', () => {
    it('continues with the next message and counts the failed report', async () => {
      const coreApi = createCoreApi({
        batches: [[message(1), message(2), message(3)]],
        reportError: (id) => (id === uuid(2) ? new CoreApiError(404, 'NOT_FOUND') : null),
      });
      const transport = createTransport();
      const summary = await drainOrderNotifications({ coreApi, transport, now: () => T0 });
      expect(transport.delivered).toHaveLength(3);
      expect(coreApi.reports).toHaveLength(3);
      expect(summary).toMatchObject({ claimed: 3, delivered: 3, reportFailed: 1 });
    });

    it('survives every report failing (network down)', async () => {
      const coreApi = createCoreApi({
        batches: [[message(1), message(2)]],
        reportError: () => new CoreApiError(0, 'NETWORK_ERROR'),
      });
      const summary = await drainOrderNotifications({
        coreApi,
        transport: createTransport(),
        now: () => T0,
      });
      expect(summary).toMatchObject({ claimed: 2, delivered: 2, reportFailed: 2 });
    });

    it('also counts failed reports for unknown events and invalid payloads', async () => {
      const coreApi = createCoreApi({
        batches: [[message(1, { event_type: 'x' }), message(2, { payload: {} })]],
        reportError: () => new CoreApiError(0, 'NETWORK_ERROR'),
      });
      const summary = await drainOrderNotifications({
        coreApi,
        transport: createTransport(),
        now: () => T0,
      });
      expect(summary).toMatchObject({ failed: 2, reportFailed: 2 });
    });
  });

  describe('batches', () => {
    it('claims further batches only while the previous one was full', async () => {
      const coreApi = createCoreApi({
        batches: [[message(1), message(2)], [message(3), message(4)], [message(5)]],
      });
      const summary = await drainOrderNotifications({
        coreApi,
        transport: createTransport(),
        limit: 2,
        maxBatches: 5,
        now: () => T0,
      });
      expect(coreApi.claims).toHaveLength(3);
      expect(summary).toMatchObject({ claimed: 5, delivered: 5 });
    });

    it('never claims more than maxBatches', async () => {
      const coreApi = createCoreApi({
        batches: [[message(1)], [message(2)], [message(3)]],
      });
      const summary = await drainOrderNotifications({
        coreApi,
        transport: createTransport(),
        limit: 1,
        maxBatches: 2,
        now: () => T0,
      });
      expect(coreApi.claims).toHaveLength(2);
      expect(summary.claimed).toBe(2);
    });

    it('stops on an empty queue', async () => {
      const coreApi = createCoreApi({ batches: [[]] });
      const summary = await drainOrderNotifications({
        coreApi,
        transport: createTransport(),
        maxBatches: 3,
        now: () => T0,
      });
      expect(coreApi.claims).toHaveLength(1);
      expect(summary).toEqual({
        claimed: 0,
        delivered: 0,
        blocked: 0,
        retried: 0,
        failed: 0,
        skipped: 0,
        reportFailed: 0,
      });
    });
  });

  describe('claim failures', () => {
    it('rejects with the CoreApiError when the first claim fails', async () => {
      const coreApi = createCoreApi({ batches: [new CoreApiError(401, 'UNAUTHORIZED')] });
      await expect(
        drainOrderNotifications({ coreApi, transport: createTransport(), now: () => T0 }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('rejects with TypeError on a malformed claim response', async () => {
      for (const response of [null, {}, { items: 'x' }, []]) {
        const coreApi = {
          claimNotifications: async () => response,
          reportNotification: async () => null,
        };
        await expect(
          drainOrderNotifications({ coreApi, transport: createTransport() }),
        ).rejects.toThrow(TypeError);
      }
    });

    it('returns what it has when a later claim fails', async () => {
      const coreApi = createCoreApi({
        batches: [[message(1), message(2)], new CoreApiError(500, 'UPSTREAM_ERROR')],
      });
      const summary = await drainOrderNotifications({
        coreApi,
        transport: createTransport(),
        limit: 2,
        maxBatches: 3,
        now: () => T0,
      });
      expect(summary).toMatchObject({ claimed: 2, delivered: 2 });
    });
  });

  it('validates limit and maxBatches before claiming', async () => {
    const coreApi = createCoreApi({ batches: [] });
    const transport = createTransport();
    for (const limit of [0, 51, 1.5, '5']) {
      await expect(drainOrderNotifications({ coreApi, transport, limit })).rejects.toThrow(
        TypeError,
      );
    }
    for (const maxBatches of [0, -1, 1.5]) {
      await expect(drainOrderNotifications({ coreApi, transport, maxBatches })).rejects.toThrow(
        TypeError,
      );
    }
    expect(coreApi.claims).toHaveLength(0);
  });

  it('never leaks payload data into reported error codes or summaries', async () => {
    const coreApi = createCoreApi({
      batches: [
        [message(1, { payload: payload({ status: 'NOPE' }) }), message(2, { event_type: 'zzz' })],
      ],
    });
    const summary = await drainOrderNotifications({
      coreApi,
      transport: createTransport(),
      now: () => T0,
    });
    for (const report of coreApi.reports) expect(report.errorCode).toMatch(/^[a-z0-9_.-]{1,64}$/);
    expect(JSON.stringify([coreApi.reports, summary])).not.toMatch(/555|261031/);
  });
});

describe('transport + outbox together', () => {
  it('maps Bot API outcomes end to end', async () => {
    const { BotApiError } = await import('sdk');
    const { createTelegramBotTransport } =
      await import('../tgcloud/lib/notifications/transport.js');
    const { createRecordingApi } = await import('./sdk-fake/api.js');
    const api = createRecordingApi();
    const script = [
      () => ({ message_id: 1 }),
      () => {
        throw new BotApiError(403, 'Forbidden: bot was blocked by the user');
      },
      () => {
        throw new BotApiError(429, 'Too Many Requests');
      },
      () => {
        throw new BotApiError(400, 'Bad Request: chat not found');
      },
      () => {
        throw new Error('ECONNRESET');
      },
    ];
    api.respond('sendMessage', () => script.shift()());
    const coreApi = createCoreApi({ batches: [[1, 2, 3, 4, 5].map((n) => message(n))] });
    const summary = await drainOrderNotifications({
      coreApi,
      transport: createTelegramBotTransport({ api }),
      now: () => T0,
    });
    expect(coreApi.reports).toEqual([
      { id: uuid(1), outcome: 'delivered' },
      { id: uuid(2), outcome: 'recipient_blocked' },
      { id: uuid(3), outcome: 'retry', errorCode: 'bot_api_429' },
      { id: uuid(4), outcome: 'failed', errorCode: 'bot_api_400' },
      { id: uuid(5), outcome: 'retry', errorCode: 'transport_error' },
    ]);
    expect(summary).toMatchObject({ claimed: 5, delivered: 1, blocked: 1, retried: 2, failed: 1 });
  });
});
