import { describe, expect, it } from 'vitest';
import { CoreApiError } from '../tgcloud/lib/coreApi/errors.js';
import {
  LEASE_MS,
  LEASE_SAFETY_MARGIN_MS,
  ORDER_ADJUSTED,
  ORDER_STAFF_ADJUSTED,
  ORDER_STAFF_ALERT,
  drainOrderNotifications,
  parseOrderAdjustedPayload,
  parseOrderStatusPayload,
  parseStaffAdjustedPayload,
  parseStaffAlertPayload,
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
  attempts: 1,
  ...extra,
});

const GROUP_ID = -1001234567890;
const staffPayload = (extra = {}) => ({
  order_id: uuid(901),
  order_number: '261031-7KQ2MX',
  status: 'NEW',
  previous_status: null,
  total_uzs: 125000,
  chat_id: GROUP_ID,
  cancelled_by_customer: false,
  ...extra,
});
const staffMessage = (n, extra = {}) =>
  message(n, { event_type: 'order.staff_alert', payload: staffPayload(), ...extra });

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

describe('parseStaffAlertPayload', () => {
  it('maps a valid payload to a staff alert notification', () => {
    expect(ORDER_STAFF_ALERT).toBe('order.staff_alert');
    expect(parseStaffAlertPayload(staffPayload())).toEqual({
      kind: 'staff_alert',
      chatId: GROUP_ID,
      orderId: uuid(901),
      orderNumber: '261031-7KQ2MX',
      status: 'NEW',
      previousStatus: null,
      totalUzs: 125000,
      cancelledByCustomer: false,
    });
    expect(
      parseStaffAlertPayload(
        staffPayload({
          status: 'CANCELLED',
          previous_status: 'CONFIRMED',
          cancelled_by_customer: true,
          extra: 'ignored',
        }),
      ),
    ).toMatchObject({
      status: 'CANCELLED',
      previousStatus: 'CONFIRMED',
      cancelledByCustomer: true,
    });
  });

  it.each([
    ['a private (positive) chat id', { chat_id: 555 }],
    ['a zero chat id', { chat_id: 0 }],
    ['an out-of-range chat id', { chat_id: -(10 ** 16) }],
    ['a string chat id', { chat_id: String(GROUP_ID) }],
    ['an unknown status', { status: 'SHIPPED' }],
    ['an unknown previous status', { previous_status: 'SHIPPED' }],
    ['a missing previous status', { previous_status: undefined }],
    ['a non-boolean cancelled flag', { cancelled_by_customer: 'yes' }],
    ['a fractional total', { total_uzs: 1.5 }],
    ['a negative total', { total_uzs: -1 }],
    ['a bad order id', { order_id: 'x' }],
    ['an empty order number', { order_number: '' }],
    ['a too long order number', { order_number: 'A'.repeat(33) }],
  ])('rejects %s', (_label, extra) => {
    expect(parseStaffAlertPayload(staffPayload(extra))).toBeNull();
  });

  it.each([null, [], 'x', 1])('rejects a non-object payload %j', (value) => {
    expect(parseStaffAlertPayload(value)).toBeNull();
  });

  it('keeps a valid destination of a NEW order', () => {
    expect(
      parseStaffAlertPayload(staffPayload({ destination: { lat: 41.311081, lon: 69.240562 } })),
    ).toEqual({
      kind: 'staff_alert',
      chatId: GROUP_ID,
      orderId: uuid(901),
      orderNumber: '261031-7KQ2MX',
      status: 'NEW',
      previousStatus: null,
      totalUzs: 125000,
      cancelledByCustomer: false,
      destination: { lat: 41.311081, lon: 69.240562 },
    });
    // Extra keys inside the destination are not carried over.
    expect(
      parseStaffAlertPayload(staffPayload({ destination: { lat: -90, lon: 180, street: 'x' } }))
        ?.destination,
    ).toEqual({ lat: -90, lon: 180 });
  });

  it.each([
    ['a string latitude', { lat: '41.3', lon: 69.2 }],
    ['an out-of-range latitude', { lat: 91, lon: 69.2 }],
    ['an out-of-range longitude', { lat: 41.3, lon: -180.1 }],
    ['a missing longitude', { lat: 41.3 }],
    ['an array', [41.3, 69.2]],
    ['null', null],
    ['a string', '41.3,69.2'],
  ])('drops %s destination but keeps the alert', (_label, destination) => {
    const alert = parseStaffAlertPayload(staffPayload({ destination }));
    expect(alert).toMatchObject({
      kind: 'staff_alert',
      status: 'NEW',
      orderNumber: '261031-7KQ2MX',
    });
    expect(alert).not.toHaveProperty('destination');
  });

  it('drops a destination on any status other than NEW', () => {
    const alert = parseStaffAlertPayload(
      staffPayload({
        status: 'CANCELLED',
        previous_status: 'NEW',
        destination: { lat: 41.311081, lon: 69.240562 },
      }),
    );
    expect(alert).toMatchObject({ status: 'CANCELLED' });
    expect(alert).not.toHaveProperty('destination');
  });
});

describe('drainOrderNotifications', () => {
  it('delivers staff alerts and customer notifications from the same batch', async () => {
    const coreApi = createCoreApi({
      batches: [[message(1), staffMessage(2, { attempts: 3 })]],
    });
    const transport = createTransport();
    const summary = await drainOrderNotifications({ coreApi, transport, now: () => T0 });
    expect(transport.delivered).toEqual([
      expect.not.objectContaining({ kind: 'staff_alert' }),
      expect.objectContaining({ kind: 'staff_alert', chatId: GROUP_ID, status: 'NEW' }),
    ]);
    expect(coreApi.reports).toEqual([
      { id: uuid(1), attempt: 1, outcome: 'delivered' },
      { id: uuid(2), attempt: 3, outcome: 'delivered' },
    ]);
    expect(summary).toMatchObject({ claimed: 2, delivered: 2 });
  });

  it('reports malformed staff alerts as failed/invalid_payload', async () => {
    const coreApi = createCoreApi({
      batches: [[staffMessage(1, { payload: staffPayload({ chat_id: 555 }) }), staffMessage(2)]],
    });
    const transport = createTransport(() => ({ outcome: 'recipient_blocked' }));
    const summary = await drainOrderNotifications({ coreApi, transport, now: () => T0 });
    expect(coreApi.reports).toEqual([
      { id: uuid(1), attempt: 1, outcome: 'failed', errorCode: 'invalid_payload' },
      { id: uuid(2), attempt: 1, outcome: 'recipient_blocked' },
    ]);
    expect(transport.delivered).toHaveLength(1);
    expect(summary).toMatchObject({ failed: 1, blocked: 1 });
  });

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
      { id: uuid(1), attempt: 1, outcome: 'delivered' },
      { id: uuid(2), attempt: 1, outcome: 'recipient_blocked' },
      { id: uuid(3), attempt: 1, outcome: 'retry', errorCode: 'bot_api_429' },
      { id: uuid(4), attempt: 1, outcome: 'failed', errorCode: 'bot_api_400' },
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
      { id: uuid(1), attempt: 1, outcome: 'failed', errorCode: 'unknown_event' },
      { id: uuid(2), attempt: 1, outcome: 'failed', errorCode: 'unknown_event' },
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
      { id: uuid(1), attempt: 1, outcome: 'failed', errorCode: 'invalid_payload' },
      { id: uuid(2), attempt: 1, outcome: 'failed', errorCode: 'invalid_payload' },
      { id: uuid(3), attempt: 1, outcome: 'delivered' },
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

  it('skips items without a usable attempt (the report would be refused) and reports the claim attempt', async () => {
    const coreApi = createCoreApi({
      batches: [
        [
          { ...message(1), attempts: undefined },
          { ...message(2), attempts: 0 },
          { ...message(3), attempts: '2' },
          { ...message(4), attempts: 3 },
        ],
      ],
    });
    const summary = await drainOrderNotifications({
      coreApi,
      transport: createTransport(),
      now: () => T0,
    });
    expect(coreApi.reports).toEqual([{ id: uuid(4), attempt: 3, outcome: 'delivered' }]);
    expect(summary).toMatchObject({ claimed: 4, delivered: 1, skipped: 3 });
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
      { id: uuid(1), attempt: 1, outcome: 'retry', errorCode: 'transport_error' },
      { id: uuid(2), attempt: 1, outcome: 'retry', errorCode: 'transport_error' },
      { id: uuid(3), attempt: 1, outcome: 'retry' },
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
      { id: uuid(1), attempt: 1, outcome: 'delivered' },
      { id: uuid(2), attempt: 1, outcome: 'recipient_blocked' },
      { id: uuid(3), attempt: 1, outcome: 'retry', errorCode: 'bot_api_429' },
      { id: uuid(4), attempt: 1, outcome: 'failed', errorCode: 'bot_api_400' },
      { id: uuid(5), attempt: 1, outcome: 'retry', errorCode: 'transport_error' },
    ]);
    expect(summary).toMatchObject({ claimed: 5, delivered: 1, blocked: 1, retried: 2, failed: 1 });
  });

  it('delivers a staff alert to the group and maps a removed bot (403) to recipient_blocked', async () => {
    const { BotApiError } = await import('sdk');
    const { createTelegramBotTransport } =
      await import('../tgcloud/lib/notifications/transport.js');
    const { createRecordingApi } = await import('./sdk-fake/api.js');
    const api = createRecordingApi();
    const script = [
      () => ({ message_id: 1 }),
      () => {
        throw new BotApiError(403, 'Forbidden: bot was kicked from the supergroup chat');
      },
      () => {
        throw new BotApiError(429, 'Too Many Requests');
      },
    ];
    api.respond('sendMessage', () => script.shift()());
    const coreApi = createCoreApi({ batches: [[1, 2, 3].map((n) => staffMessage(n))] });
    const summary = await drainOrderNotifications({
      coreApi,
      transport: createTelegramBotTransport({ api }),
      now: () => T0,
    });
    expect(api.calls[0].params.chat_id).toBe(GROUP_ID);
    expect(api.calls[0].params.parse_mode).toBe('HTML');
    expect(coreApi.reports).toEqual([
      { id: uuid(1), attempt: 1, outcome: 'delivered' },
      { id: uuid(2), attempt: 1, outcome: 'recipient_blocked' },
      { id: uuid(3), attempt: 1, outcome: 'retry', errorCode: 'bot_api_429' },
    ]);
    expect(summary).toMatchObject({ claimed: 3, delivered: 1, blocked: 1, retried: 1 });
  });
});

// --- order details in the staff alert (owner's request) and shortage adjustments (ADR 0018) -----

const details = (extra = {}) => ({
  items: [
    { name_uz: 'Olma', quantity: 2, unit: 'kg', line_total_uzs: 30000 },
    { name_uz: 'Non', quantity: 3, unit: 'piece', line_total_uzs: 12000 },
  ],
  subtotal_uzs: 42000,
  payment_method: 'cash_on_delivery',
  recipient_phone: '+998001234567',
  address: {
    street: 'Demo ko‘cha',
    house: '15',
    apartment: '12',
    entrance: null,
    floor: '3',
    landmark: null,
  },
  comment: null,
  created_at: '2026-11-13T10:05:00.123456+00:00',
  ...extra,
});

describe('parseStaffAlertPayload: recipient and details', () => {
  it('carries the recipient name and the details of a NEW order', () => {
    const alert = parseStaffAlertPayload(
      staffPayload({ recipient_name: 'Demo Mijoz', details: details() }),
    );
    expect(alert?.recipientName).toBe('Demo Mijoz');
    expect(alert?.details).toEqual({
      items: [
        { nameUz: 'Olma', quantity: 2, unit: 'kg', lineTotalUzs: 30000 },
        { nameUz: 'Non', quantity: 3, unit: 'piece', lineTotalUzs: 12000 },
      ],
      subtotalUzs: 42000,
      paymentMethod: 'cash_on_delivery',
      recipientPhone: '+998001234567',
      address: {
        street: 'Demo ko‘cha',
        house: '15',
        apartment: '12',
        entrance: null,
        floor: '3',
        landmark: null,
      },
      comment: null,
      createdAt: '2026-11-13T10:05:00.123456+00:00',
    });
  });

  it.each([
    ['no items', { items: [] }],
    ['a bad unit', { items: [{ name_uz: 'X', quantity: 1, unit: 'box', line_total_uzs: 1 }] }],
    ['a bad payment method', { payment_method: 'crypto' }],
    ['a missing street', { address: { house: '1' } }],
    ['a numeric comment', { comment: 5 }],
    ['a fractional subtotal', { subtotal_uzs: 1.5 }],
  ])('drops details with %s but still delivers the alert', (_label, extra) => {
    const alert = parseStaffAlertPayload(staffPayload({ details: details(extra) }));
    expect(alert).not.toBeNull();
    expect(alert).not.toHaveProperty('details');
  });

  it('ignores details on any status but NEW, and a non-string recipient', () => {
    const alert = parseStaffAlertPayload(
      staffPayload({ status: 'DELIVERED', details: details(), recipient_name: 42 }),
    );
    expect(alert).not.toHaveProperty('details');
    expect(alert).not.toHaveProperty('recipientName');
  });
});

const adjustedPayload = (extra = {}) => ({
  order_id: uuid(902),
  order_number: '261031-7KQ2MX',
  status: 'PICKING',
  locale: 'ru',
  total_uzs: 23000,
  chat_id: 555,
  changes: [{ name_uz: 'Olma', name_ru: 'Яблоко', unit: 'kg', from_quantity: 3, to_quantity: 1 }],
  ...extra,
});

describe('parseOrderAdjustedPayload', () => {
  it('maps a valid payload', () => {
    expect(ORDER_ADJUSTED).toBe('order.adjusted');
    expect(parseOrderAdjustedPayload(adjustedPayload())).toEqual({
      kind: 'order_adjusted',
      chatId: 555,
      orderNumber: '261031-7KQ2MX',
      locale: 'ru',
      totalUzs: 23000,
      changes: [{ nameUz: 'Olma', nameRu: 'Яблоко', unit: 'kg', fromQuantity: 3, toQuantity: 1 }],
    });
  });

  it.each([
    ['a group chat', { chat_id: -100 }],
    ['an unknown locale', { locale: 'en' }],
    ['no changes', { changes: [] }],
    [
      'a raised line',
      { changes: [{ name_uz: 'a', name_ru: 'a', unit: 'kg', from_quantity: 1, to_quantity: 2 }] },
    ],
    [
      'an unknown unit',
      { changes: [{ name_uz: 'a', name_ru: 'a', unit: 'box', from_quantity: 2, to_quantity: 1 }] },
    ],
    ['a negative total', { total_uzs: -1 }],
    ['a bad order id', { order_id: 'x' }],
  ])('rejects %s', (_label, extra) => {
    expect(parseOrderAdjustedPayload(adjustedPayload(extra))).toBeNull();
  });
});

const staffAdjustedPayload = (extra = {}) => ({
  order_id: uuid(903),
  order_number: '261031-7KQ2MX',
  status: 'PICKING',
  total_uzs: 23000,
  chat_id: GROUP_ID,
  recipient_name: 'Demo Mijoz',
  changes: [
    {
      name_uz: 'Olma',
      name_ru: 'Яблоко',
      unit: 'kg',
      from_quantity: 3,
      to_quantity: 1,
      marked_out_of_stock: true,
    },
  ],
  reason: 'Ikkitasi ezilgan',
  ...extra,
});

describe('parseStaffAdjustedPayload', () => {
  it('maps a valid payload', () => {
    expect(ORDER_STAFF_ADJUSTED).toBe('order.staff_adjusted');
    expect(parseStaffAdjustedPayload(staffAdjustedPayload())).toEqual({
      kind: 'staff_adjusted',
      chatId: GROUP_ID,
      orderId: uuid(903),
      orderNumber: '261031-7KQ2MX',
      totalUzs: 23000,
      recipientName: 'Demo Mijoz',
      changes: [
        { nameUz: 'Olma', unit: 'kg', fromQuantity: 3, toQuantity: 1, markedOutOfStock: true },
      ],
      reason: 'Ikkitasi ezilgan',
    });
  });

  it.each([
    ['a private chat', { chat_id: 555 }],
    ['no reason', { reason: undefined }],
    [
      'a missing out-of-stock flag',
      { changes: [{ name_uz: 'a', name_ru: 'a', unit: 'kg', from_quantity: 2, to_quantity: 1 }] },
    ],
  ])('rejects %s', (_label, extra) => {
    expect(parseStaffAdjustedPayload(staffAdjustedPayload(extra))).toBeNull();
  });
});

describe('drain: adjustment events', () => {
  it('delivers both adjustment events through the transport', async () => {
    const delivered = [];
    const transport = {
      async deliver(notification) {
        delivered.push(notification.kind);
        return { outcome: 'delivered' };
      },
    };
    const coreApi = createCoreApi({
      batches: [
        [
          message(1, { event_type: 'order.adjusted', payload: adjustedPayload() }),
          message(2, { event_type: 'order.staff_adjusted', payload: staffAdjustedPayload() }),
          message(3, { event_type: 'order.adjusted', payload: adjustedPayload({ changes: [] }) }),
        ],
      ],
    });
    const summary = await drainOrderNotifications({ coreApi, transport, now: () => T0 });
    expect(delivered).toEqual(['order_adjusted', 'staff_adjusted']);
    expect(coreApi.reports.at(-1)).toEqual({
      id: uuid(3),
      attempt: 1,
      outcome: 'failed',
      errorCode: 'invalid_payload',
    });
    expect(summary).toMatchObject({ claimed: 3, delivered: 2, failed: 1 });
  });
});
