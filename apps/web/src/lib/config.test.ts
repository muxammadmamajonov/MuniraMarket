import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiUrl, getApiBaseUrl } from './config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('config', () => {
  it('defaults to localhost', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', undefined);
    expect(getApiBaseUrl()).toBe('http://localhost:8000');
  });

  it('strips trailing slashes and joins the v1 prefix', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'http://api.test:9000//');
    expect(getApiBaseUrl()).toBe('http://api.test:9000');
    expect(apiUrl('/health')).toBe('http://api.test:9000/api/v1/health');
    expect(apiUrl('health')).toBe('http://api.test:9000/api/v1/health');
  });
});
