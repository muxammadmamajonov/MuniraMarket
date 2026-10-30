import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApiInternalUrl, getClientIpHeader, internalApiUrl } from './config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('config', () => {
  it('defaults to localhost', () => {
    vi.stubEnv('API_INTERNAL_URL', undefined);
    expect(getApiInternalUrl()).toBe('http://localhost:8000');
  });

  it('treats an empty value as unset', () => {
    vi.stubEnv('API_INTERNAL_URL', '  ');
    expect(getApiInternalUrl()).toBe('http://localhost:8000');
  });

  it('strips trailing slashes and joins the v1 prefix', () => {
    vi.stubEnv('API_INTERNAL_URL', 'http://api.test:9000//');
    expect(getApiInternalUrl()).toBe('http://api.test:9000');
    expect(internalApiUrl('/health')).toBe('http://api.test:9000/api/v1/health');
    expect(internalApiUrl('health')).toBe('http://api.test:9000/api/v1/health');
  });

  it('does not read a NEXT_PUBLIC variable (the API URL is never public)', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'http://leak.test');
    vi.stubEnv('API_INTERNAL_URL', undefined);
    expect(getApiInternalUrl()).toBe('http://localhost:8000');
  });

  it('reads CLIENT_IP_HEADER as a lower-case header name, or null', () => {
    vi.stubEnv('CLIENT_IP_HEADER', '');
    expect(getClientIpHeader()).toBeNull();
    vi.stubEnv('CLIENT_IP_HEADER', ' X-Real-IP ');
    expect(getClientIpHeader()).toBe('x-real-ip');
    vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip\r\nx-evil');
    expect(getClientIpHeader()).toBeNull();
  });
});
