import { describe, expect, it } from 'vitest';
import { ApiRequestError, parseRetryAfter } from './errors';

describe('parseRetryAfter', () => {
  const NOW = Date.parse('2026-10-31T10:00:00Z');

  it('reads a number of seconds', () => {
    expect(parseRetryAfter('7', NOW)).toBe(7);
    expect(parseRetryAfter(' 30 ', NOW)).toBe(30);
    expect(parseRetryAfter('1.5', NOW)).toBe(1.5);
  });

  it('reads an HTTP date as the seconds until then', () => {
    expect(parseRetryAfter('Sat, 31 Oct 2026 10:00:45 GMT', NOW)).toBe(45);
  });

  it('is null for missing, empty, zero, negative, past and malformed values', () => {
    for (const value of [null, '', '  ', '0', '-5', 'soon', 'Sat, 31 Oct 2026 09:59:00 GMT']) {
      expect(parseRetryAfter(value, NOW), String(value)).toBeNull();
    }
  });
});

describe('ApiRequestError.fromResponse', () => {
  it('carries Retry-After in seconds from the header, with or without an envelope', async () => {
    const envelope = Response.json(
      { error: { code: 'rate_limited', message: 'slow down' } },
      { status: 429, headers: { 'Retry-After': '9' } },
    );
    const withEnvelope = await ApiRequestError.fromResponse(envelope);
    expect(withEnvelope.code).toBe('rate_limited');
    expect(withEnvelope.retryAfter).toBe(9);

    const html = new Response('<html>Too Many Requests</html>', {
      status: 429,
      headers: { 'Retry-After': '4' },
    });
    const withoutEnvelope = await ApiRequestError.fromResponse(html);
    expect(withoutEnvelope.code).toBe('unknown_error');
    expect(withoutEnvelope.retryAfter).toBe(4);
  });
});
