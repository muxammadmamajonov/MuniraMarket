import { describe, expect, it } from 'vitest';
import { READINESS_PROBES, READY_CACHE_MS, createReadiness } from '../../src/readiness.ts';

describe('readiness', () => {
  it('probes the database, the security-state tables and the latest migrations', () => {
    expect(READINESS_PROBES[0]).toBe('SELECT 1');
    const text = READINESS_PROBES.join('\n');
    for (const needle of [
      'auth_sessions',
      'oidc_login_states',
      'user_addresses',
      'safety_stock',
      'order_item_adjustments',
    ]) {
      expect(text).toContain(needle);
    }
    // LIMIT 0: a probe never reads a row.
    for (const probe of READINESS_PROBES.slice(1)) expect(probe).toMatch(/ LIMIT 0$/);
  });

  it('reuses a passing result for a short time, then probes again', async () => {
    let clock = 1_000;
    const ran: string[] = [];
    const check = createReadiness(
      async (sql) => {
        ran.push(sql);
      },
      { now: () => clock },
    );
    await check();
    expect(ran).toEqual([...READINESS_PROBES]);
    await check();
    expect(ran).toHaveLength(READINESS_PROBES.length);
    clock += READY_CACHE_MS;
    await check();
    expect(ran).toHaveLength(READINESS_PROBES.length * 2);
  });

  it('fails when a probe fails and never caches the failure', async () => {
    let broken = true;
    const check = createReadiness(async (sql) => {
      if (broken && sql.includes('safety_stock')) throw new Error('column does not exist');
    });
    await expect(check()).rejects.toThrow('column does not exist');
    broken = false;
    await expect(check()).resolves.toBeUndefined();
  });
});
