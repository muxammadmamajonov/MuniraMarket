import { describe, expect, it } from 'vitest';
import { errorFields, redact } from '../../src/logging.ts';

describe('errorFields', () => {
  it('logs class and codes only, never a message that could carry a host or a row', () => {
    const network = Object.assign(
      new Error('getaddrinfo ENOTFOUND ep-fake-1-pooler.example.neon.tech'),
      {
        code: 'ENOTFOUND',
        hostname: 'ep-fake-1-pooler.example.neon.tech',
      },
    );
    expect(errorFields(network)).toEqual({ error: 'Error', code: 'ENOTFOUND' });
    const pg = Object.assign(
      new Error('violates check; DETAIL: Failing row contains (+998901234567)'),
      {
        code: '23514',
        constraint: 'orders_total_check',
      },
    );
    expect(errorFields(pg)).toEqual({
      error: 'Error',
      sqlstate: '23514',
      constraint: 'orders_total_check',
    });
    expect(JSON.stringify(errorFields(network))).not.toContain('neon.tech');
  });
});

describe('redact', () => {
  it('masks credentials inside connection URLs', () => {
    expect(
      redact('connect postgresql://mm_app:fake-pw@ep-x-pooler.example/db failed'),
    ).not.toContain('fake-pw');
  });
});
