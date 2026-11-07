import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isAllowed } from '../src/routing';
import {
  CLEANUP_PATH,
  DEFAULT_SCHEDULER_KEY_ID,
  DRAIN_PATH,
  type LogFn,
  SCHEDULER_BASE_URL,
  isCleanupTick,
  runScheduledTick,
  selectSigningKey,
  summaryCounts,
} from '../src/scheduler';

// Test-only values; not real credentials.
const SECRET = 'test-only-scheduler-secret-0123456789abcdef';
const T0 = Date.parse('2026-11-06T10:01:00Z'); // minute 1: no cleanup
const T15 = Date.parse('2026-11-06T10:15:00Z'); // minute 15: cleanup

function recorder() {
  const lines: Array<{ level: string; message: string; fields?: Record<string, unknown> | undefined }> = [];
  const log: LogFn = (level, message, fields) => lines.push({ level, message, fields });
  return { lines, log };
}

/** Recomputes the ADR 0003 signature the Function will verify. */
function expectValidSignature(request: Request, body: string) {
  const url = new URL(request.url);
  const canonical = [
    'MM-SVC-V1',
    request.headers.get('x-mm-key-id'),
    request.headers.get('x-mm-timestamp'),
    request.headers.get('x-mm-nonce'),
    request.method,
    `${url.pathname}${url.search}`,
    request.headers.get('x-mm-actor'),
    createHash('sha256').update(body).digest('hex'),
  ].join('\n');
  expect(request.headers.get('x-mm-signature')).toBe(
    createHmac('sha256', SECRET).update(canonical).digest('hex'),
  );
}

function fakeForward(responses: Record<string, () => Response | Promise<Response>>) {
  const calls: Array<{ request: Request; body: string }> = [];
  const forward = async (request: Request) => {
    const body = await request.clone().text();
    calls.push({ request, body });
    const path = new URL(request.url).pathname;
    // The scheduler may only ever use routes the scheduler entrance allows.
    expect(isAllowed('scheduler', request.method, path)).toBe(true);
    const make = responses[path];
    if (!make) throw new Error(`unexpected ${path}`);
    return make();
  };
  return { calls, forward };
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

describe('selectSigningKey', () => {
  it('uses the scheduler secret with the default key id', () => {
    expect(selectSigningKey({ SCHEDULER_SERVICE_SECRET: SECRET })).toEqual({
      ok: true,
      keyId: DEFAULT_SCHEDULER_KEY_ID,
      secret: SECRET,
    });
    expect(
      selectSigningKey({ SCHEDULER_SERVICE_SECRET: SECRET, SCHEDULER_SERVICE_KEY_ID: 'cron' }),
    ).toMatchObject({ ok: true, keyId: 'cron' });
  });

  it.each([
    [{}, 'secret_missing'],
    [{ SCHEDULER_SERVICE_SECRET: '   ' }, 'secret_missing'],
    [{ SCHEDULER_SERVICE_SECRET: 'short' }, 'secret_too_short'],
    [{ SCHEDULER_SERVICE_SECRET: SECRET, SCHEDULER_SERVICE_KEY_ID: 'bad key!' }, 'key_id_invalid'],
  ])('fails closed for %j (%s)', (env, reason) => {
    expect(selectSigningKey(env)).toEqual({ ok: false, reason });
  });
});

describe('isCleanupTick', () => {
  it('runs on minutes 0, 15, 30 and 45 UTC only', () => {
    expect(isCleanupTick(Date.parse('2026-11-06T10:00:00Z'))).toBe(true);
    expect(isCleanupTick(T15)).toBe(true);
    expect(isCleanupTick(Date.parse('2026-11-06T10:45:59Z'))).toBe(true);
    expect(isCleanupTick(T0)).toBe(false);
    expect(isCleanupTick(Number.NaN)).toBe(false);
  });
});

describe('summaryCounts', () => {
  it('keeps non-negative integer counts only, never ids', () => {
    expect(
      summaryCounts({ claimed: 2, delivered: 1, failed: -1, retried: 1.5, ids: ['x'], chat_id: 5 }),
    ).toEqual({ claimed: 2, delivered: 1 });
    expect(summaryCounts(null)).toEqual({});
  });
});

describe('runScheduledTick', () => {
  it('signs one empty-actor POST to the drain route and nothing else on a normal minute', async () => {
    const { calls, forward } = fakeForward({ [DRAIN_PATH]: () => json({ claimed: 0 }) });
    const { log } = recorder();
    const result = await runScheduledTick({
      env: { SCHEDULER_SERVICE_SECRET: SECRET },
      scheduledTime: T0,
      forward,
      log,
      now: () => T0,
    });
    expect(result).toEqual({ drain: 'ok', cleanup: 'not_due' });
    expect(calls).toHaveLength(1);
    const [{ request, body }] = calls as [{ request: Request; body: string }];
    expect(request.url).toBe(`${SCHEDULER_BASE_URL}${DRAIN_PATH}`);
    expect(request.method).toBe('POST');
    expect(request.headers.get('x-mm-key-id')).toBe('scheduler');
    expect(request.headers.get('x-mm-actor')).toBe('');
    expectValidSignature(request, body);
  });

  it('drains then cleans up on a 15-minute tick, logging counts only', async () => {
    const { calls, forward } = fakeForward({
      [DRAIN_PATH]: () => json({ claimed: 3, delivered: 3, chat_ids: [1, 2] }),
      [CLEANUP_PATH]: () => json({ status: 'ok' }),
    });
    const { lines, log } = recorder();
    const result = await runScheduledTick({
      env: { SCHEDULER_SERVICE_SECRET: SECRET },
      scheduledTime: T15,
      forward,
      log,
      now: () => T15,
    });
    expect(result).toEqual({ drain: 'ok', cleanup: 'ok' });
    expect(calls.map((c) => new URL(c.request.url).pathname)).toEqual([DRAIN_PATH, CLEANUP_PATH]);
    for (const call of calls) expectValidSignature(call.request, call.body);
    expect(JSON.stringify(lines)).not.toContain('chat_ids');
    expect(lines.find((l) => l.message.includes('drained'))?.fields).toEqual({
      claimed: 3,
      delivered: 3,
    });
  });

  it('uses a fresh nonce per request (replay-safe retries)', async () => {
    const { calls, forward } = fakeForward({
      [DRAIN_PATH]: () => json({}),
      [CLEANUP_PATH]: () => json({}),
    });
    await runScheduledTick({
      env: { SCHEDULER_SERVICE_SECRET: SECRET },
      scheduledTime: T15,
      forward,
      log: recorder().log,
    });
    const nonces = calls.map((c) => c.request.headers.get('x-mm-nonce'));
    expect(new Set(nonces).size).toBe(2);
  });

  it('still runs the cleanup when the drain fails, and logs status/code only', async () => {
    const { forward } = fakeForward({
      [DRAIN_PATH]: () => json({ error: { code: 'service_unavailable', message: 'x' } }, 503),
      [CLEANUP_PATH]: () => json({}),
    });
    const { lines, log } = recorder();
    const result = await runScheduledTick({
      env: { SCHEDULER_SERVICE_SECRET: SECRET },
      scheduledTime: T15,
      forward,
      log,
    });
    expect(result).toEqual({ drain: 'failed', cleanup: 'ok' });
    const failure = lines.find((l) => l.message.includes('drain failed'));
    expect(failure?.fields).toMatchObject({ error: 'CoreApiError', status: 503 });
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('never rejects when forward() throws (timeouts, network)', async () => {
    const forward = async () => {
      throw new DOMException('timed out', 'TimeoutError');
    };
    const result = await runScheduledTick({
      env: { SCHEDULER_SERVICE_SECRET: SECRET },
      scheduledTime: T15,
      forward,
      log: recorder().log,
    });
    expect(result).toEqual({ drain: 'failed', cleanup: 'failed' });
  });

  it('skips the whole tick without a usable signing key (no request at all)', async () => {
    const { calls, forward } = fakeForward({});
    const { lines, log } = recorder();
    const result = await runScheduledTick({
      env: {},
      scheduledTime: T15,
      forward,
      log,
    });
    expect(result).toEqual({ drain: 'skipped', cleanup: 'skipped' });
    expect(calls).toHaveLength(0);
    expect(lines[0]?.fields).toEqual({ reason: 'secret_missing' });
  });
});
