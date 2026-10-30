// @ts-check

/**
 * Typed Core API failure. `message` is deliberately generic: it never contains the response body,
 * the request body, the signing secret or the query string, so it is safe to log.
 */
export class CoreApiError extends Error {
  /**
   * @param {number} status HTTP status, or 0 when no response was received
   * @param {string} code stable machine-readable code
   */
  constructor(status, code) {
    super(`Core API request failed (status ${status}, code ${code})`);
    this.name = 'CoreApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {number} status
 * @returns {string}
 */
export function codeForStatus(status) {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 400 && status < 500) return 'BAD_REQUEST';
  if (status >= 500) return 'UPSTREAM_ERROR';
  return 'UNEXPECTED_STATUS';
}
