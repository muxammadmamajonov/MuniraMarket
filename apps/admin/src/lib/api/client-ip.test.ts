import { describe, expect, it } from 'vitest';
import { clientIpFrom } from './client-ip';

describe('clientIpFrom', () => {
  it('is null when no edge header is configured', () => {
    expect(clientIpFrom(new Headers({ 'x-real-ip': '198.51.100.4' }), null)).toBeNull();
  });

  it('reads a single valid IPv4 or IPv6 address from the configured header only', () => {
    const headers = new Headers({
      'x-real-ip': ' 198.51.100.4 ',
      'x-forwarded-for': '203.0.113.7',
    });
    expect(clientIpFrom(headers, 'x-real-ip')).toBe('198.51.100.4');
    expect(clientIpFrom(new Headers({ 'x-real-ip': '2001:db8::1' }), 'x-real-ip')).toBe(
      '2001:db8::1',
    );
  });

  it('rejects lists, garbage and missing values', () => {
    for (const bad of ['198.51.100.4, 10.0.0.1', 'not-an-ip', '']) {
      expect(clientIpFrom(new Headers({ 'x-real-ip': bad }), 'x-real-ip')).toBeNull();
    }
    expect(clientIpFrom(new Headers(), 'x-real-ip')).toBeNull();
  });
});
