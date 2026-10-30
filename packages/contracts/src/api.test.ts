import { describe, expect, it } from 'vitest';
import {
  API_V1_PREFIX,
  type HealthResponse,
  type TelegramInitDataAuthRequest,
  type TelegramInitDataAuthResponse,
  type UserPublic,
  isApiErrorBody,
} from './index';

describe('api contract', () => {
  it('exposes the v1 prefix', () => {
    expect(API_V1_PREFIX).toBe('/api/v1');
  });

  it('isApiErrorBody recognises the error envelope', () => {
    expect(isApiErrorBody({ error: { code: 'unauthorized', message: 'Unauthorized' } })).toBe(true);
  });

  it('isApiErrorBody rejects malformed values', () => {
    expect(isApiErrorBody(null)).toBe(false);
    expect(isApiErrorBody('error')).toBe(false);
    expect(isApiErrorBody([])).toBe(false);
    expect(isApiErrorBody({})).toBe(false);
    expect(isApiErrorBody({ error: 'boom' })).toBe(false);
    expect(isApiErrorBody({ error: { code: 1, message: 'x' } })).toBe(false);
    expect(isApiErrorBody({ error: { code: 'x' } })).toBe(false);
  });

  it('request/response shapes compile as documented', () => {
    const user: UserPublic = {
      id: '0b9d2c5e-0000-4000-8000-000000000000',
      telegram_user_id: 1,
      first_name: 'Test',
      last_name: null,
      username: null,
      language: 'uz',
      role: 'customer',
    };
    const request: TelegramInitDataAuthRequest = { init_data: 'query_id=x' };
    const response: TelegramInitDataAuthResponse = { user };
    const health: HealthResponse = { status: 'ok', service: 'core-api', version: '0.1.0' };

    expect(request.init_data).toBe('query_id=x');
    expect(response.user.role).toBe('customer');
    expect(health.status).toBe('ok');
  });
});
