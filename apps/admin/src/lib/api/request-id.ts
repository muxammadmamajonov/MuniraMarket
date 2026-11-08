/**
 * Request ids and the "support code" operators use to find a failed request in the logs.
 *
 * The admin API proxy gives every request a 32-character hex id and sends it upstream as
 * `X-Request-ID`; the Cloudflare gateway and the Core API Function log it as `request_id` and
 * return it on the response. The UI shows only its first {@link SUPPORT_CODE_LENGTH} characters
 * (the "support code"): short enough to read out over the phone, and a prefix search over a few
 * minutes of logs finds exactly one request. It reveals nothing about the user or the request.
 */

export const REQUEST_ID_HEADER = 'x-request-id';

/** Same shape the gateway and the Core API accept (`[A-Za-z0-9._-]{8,128}`). */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export const SUPPORT_CODE_LENGTH = 8;

const SUPPORT_CODE_PATTERN = /^[a-z0-9]{8}$/;

/** A fresh request id: 32 lowercase hex characters. */
export function newRequestId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/** The request id from a header value, or `null` when missing or malformed. */
export function parseRequestId(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && REQUEST_ID_PATTERN.test(value) ? value : null;
}

/**
 * The support code for a request id: its first eight letters/digits, lowercased, or `null` when
 * there are not enough of them.
 */
export function supportCodeFor(requestId: string | null | undefined): string | null {
  if (requestId === null || requestId === undefined) return null;
  const code = requestId
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, SUPPORT_CODE_LENGTH)
    .toLowerCase();
  return SUPPORT_CODE_PATTERN.test(code) ? code : null;
}

/** A support code from a URL parameter (`?ref=`), or `null` unless it has the exact shape. */
export function parseSupportCode(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && SUPPORT_CODE_PATTERN.test(value) ? value : null;
}
