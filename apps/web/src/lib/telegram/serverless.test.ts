import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerlessCallError, callServerless } from './serverless';
import { installWebApp, makeWebApp, uninstallWebApp } from './test-helpers';
import type { TelegramServerlessCallback } from './types';

afterEach(() => {
  uninstallWebApp();
  vi.useRealTimers();
});

describe('callServerless outside Telegram', () => {
  it('rejects immediately with NOT_IN_TELEGRAM in a plain browser', async () => {
    const error = await callServerless('catalog.list').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerlessCallError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'ServerlessCallError',
      type: 'NOT_IN_TELEGRAM',
      status: 0,
    });
  });

  it('rejects with NOT_IN_TELEGRAM when the script is loaded but initData is empty', async () => {
    installWebApp(makeWebApp({ initData: '' }));
    await expect(callServerless('x')).rejects.toMatchObject({ type: 'NOT_IN_TELEGRAM' });
  });

  it('rejects with SERVERLESS_UNAVAILABLE when the client has no Serverless API', async () => {
    installWebApp(makeWebApp());
    await expect(callServerless('x')).rejects.toMatchObject({ type: 'SERVERLESS_UNAVAILABLE' });
  });
});

describe('callServerless inside Telegram', () => {
  let call: ReturnType<
    typeof vi.fn<(name: string, input?: unknown, cb?: TelegramServerlessCallback) => void>
  >;

  beforeEach(() => {
    call = vi.fn();
    installWebApp(makeWebApp({ Serverless: { call } }));
  });

  it('resolves with the result and passes name and input through', async () => {
    call.mockImplementation((_name, _input, cb) => cb?.(null, { ok: true }));
    await expect(callServerless<{ ok: boolean }>('session.start', { a: 1 })).resolves.toEqual({
      ok: true,
    });
    expect(call).toHaveBeenCalledWith('session.start', { a: 1 }, expect.any(Function));
  });

  it('rejects with a typed error carrying message, type, status and parameters', async () => {
    call.mockImplementation((_name, _input, cb) =>
      cb?.({ message: 'Too many', type: 'RATE_LIMITED', status: 429, parameters: { retry: 5 } }),
    );
    const error = await callServerless('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerlessCallError);
    expect(error).toMatchObject({
      message: 'Too many',
      type: 'RATE_LIMITED',
      status: 429,
      parameters: { retry: 5 },
    });
  });

  it('defaults the type when the runtime omits it', async () => {
    call.mockImplementation((_name, _input, cb) => cb?.({ message: 'Boom', status: 500 }));
    await expect(callServerless('x')).rejects.toMatchObject({
      type: 'SERVERLESS_ERROR',
      status: 500,
      parameters: undefined,
    });
  });

  it('maps a synchronous throw to CLIENT_ERROR', async () => {
    call.mockImplementation(() => {
      throw new Error('bridge closed');
    });
    await expect(callServerless('x')).rejects.toMatchObject({
      type: 'CLIENT_ERROR',
      message: 'bridge closed',
    });
  });

  it('rejects with TIMEOUT when no callback arrives', async () => {
    vi.useFakeTimers();
    call.mockImplementation(() => undefined);
    const promise = callServerless('slow', undefined, { timeoutMs: 1000 });
    const assertion = expect(promise).rejects.toMatchObject({ type: 'TIMEOUT', status: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('does not time out after a successful call', async () => {
    vi.useFakeTimers();
    call.mockImplementation((_name, _input, cb) => cb?.(null, 1));
    await expect(callServerless<number>('x', undefined, { timeoutMs: 1000 })).resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
  });
});
