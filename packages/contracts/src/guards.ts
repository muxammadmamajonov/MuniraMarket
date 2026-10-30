import type { ApiErrorEnvelope } from './api';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows an unknown JSON value to the standard API error envelope. */
export function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (!isRecord(value)) return false;
  const error = value['error'];
  return (
    isRecord(error) && typeof error['code'] === 'string' && typeof error['message'] === 'string'
  );
}
