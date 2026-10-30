import { getTelegramWebApp } from './webapp';
import type { TelegramServerlessError } from './types';

export type ServerlessErrorType =
  | 'NOT_IN_TELEGRAM'
  | 'SERVERLESS_UNAVAILABLE'
  | 'CLIENT_ERROR'
  | 'TIMEOUT'
  // Error types reported by the Serverless runtime itself.
  | (string & {});

export interface ServerlessCallErrorInit {
  message: string;
  type: ServerlessErrorType;
  status: number;
  parameters?: Record<string, unknown> | undefined;
}

export class ServerlessCallError extends Error {
  readonly type: ServerlessErrorType;
  /** HTTP-like status from the runtime, or 0 when the call never reached it. */
  readonly status: number;
  readonly parameters: Record<string, unknown> | undefined;

  constructor({ message, type, status, parameters }: ServerlessCallErrorInit) {
    super(message);
    this.name = 'ServerlessCallError';
    this.type = type;
    this.status = status;
    this.parameters = parameters;
  }

  static fromPayload(payload: TelegramServerlessError): ServerlessCallError {
    return new ServerlessCallError({
      message: payload.message,
      type: payload.type ?? 'SERVERLESS_ERROR',
      status: payload.status,
      parameters: payload.parameters,
    });
  }
}

export interface CallServerlessOptions {
  /** Reject with type `TIMEOUT` if no callback arrives in time. Default 15000 ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Calls a Telegram Serverless endpoint through `Telegram.WebApp.Serverless.call`.
 *
 * Rejects with {@link ServerlessCallError}; outside Telegram it rejects immediately with type
 * `NOT_IN_TELEGRAM`. Telegram attaches the verified user to the request on its side, so callers
 * must NOT pass a user id in `input` to say who they are.
 */
export function callServerless<T>(
  name: string,
  input?: unknown,
  options: CallServerlessOptions = {},
): Promise<T> {
  const webApp = getTelegramWebApp();
  if (webApp === null || webApp.initData === '') {
    return Promise.reject(
      new ServerlessCallError({
        message: 'Not running inside Telegram.',
        type: 'NOT_IN_TELEGRAM',
        status: 0,
      }),
    );
  }

  const serverless = webApp.Serverless;
  if (serverless === undefined) {
    return Promise.reject(
      new ServerlessCallError({
        message: 'Telegram Serverless is not available in this client.',
        type: 'SERVERLESS_UNAVAILABLE',
        status: 0,
      }),
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ServerlessCallError({
          message: `Serverless call "${name}" timed out after ${String(timeoutMs)} ms.`,
          type: 'TIMEOUT',
          status: 0,
        }),
      );
    }, timeoutMs);

    try {
      serverless.call(name, input, (error, result) => {
        clearTimeout(timer);
        if (error) reject(ServerlessCallError.fromPayload(error));
        else resolve(result as T);
      });
    } catch (cause) {
      clearTimeout(timer);
      reject(
        new ServerlessCallError({
          message: cause instanceof Error ? cause.message : 'Serverless call failed.',
          type: 'CLIENT_ERROR',
          status: 0,
        }),
      );
    }
  });
}
