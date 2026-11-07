/** Public delivery zones over HTTP (port of test_delivery_zones_are_public_and_cached). */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db.ts';
import {
  call,
  createTestApp,
  hasDatabase,
  resetDatabase,
  testDatabase,
} from '../helpers/harness.ts';
import { addZone } from './catalog.seed.ts';

describe.skipIf(!hasDatabase)('delivery zones', () => {
  const db = testDatabase() as Database;
  // 2026-10-31 04:30 UTC = 09:30 in Tashkent.
  const app = createTestApp({ db, clock: () => Date.parse('2026-10-31T04:30:00Z') / 1000 });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('lists active zones in order with districts, hours and is_open_now; cached publicly', async () => {
    await addZone(db, 'demo-a', ['yunusobod', 'mirobod'], {
      sortOrder: 1,
      opensAt: '09:00',
      closesAt: '21:00',
    });
    await addZone(db, 'demo-b', ['sergeli'], {
      sortOrder: 2,
      threshold: null,
      opensAt: '10:00',
      closesAt: '20:30',
    });
    await addZone(db, 'demo-off', ['bektemir'], { isActive: false });

    const response = await call(app, 'GET', '/api/v1/delivery/zones', { entrance: 'public' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.get('set-cookie')).toBeNull();
    const body = (await response.json()) as { items: Record<string, unknown>[]; timezone: string };
    expect(body.timezone).toBe('Asia/Tashkent');
    expect(Object.keys(body)).toEqual(['items', 'timezone']);
    expect(body.items.map((z) => z['slug'])).toEqual(['demo-a', 'demo-b']);
    const [first, second] = body.items;
    expect(first).toEqual({
      id: expect.any(String),
      slug: 'demo-a',
      name_uz: 'Demo demo-a',
      name_ru: 'Демо demo-a',
      delivery_fee_uzs: 15_000,
      free_delivery_threshold_uzs: 300_000,
      min_order_uzs: 50_000,
      opens_at: '09:00',
      closes_at: '21:00',
      is_open_now: true,
      districts: [
        { code: 'mirobod', name_uz: 'Mirobod', name_ru: 'Мирабадский' },
        { code: 'yunusobod', name_uz: 'Yunusobod', name_ru: 'Юнусабадский' },
      ],
    });
    expect(Object.keys(first!)).toEqual([
      'id',
      'slug',
      'name_uz',
      'name_ru',
      'delivery_fee_uzs',
      'free_delivery_threshold_uzs',
      'min_order_uzs',
      'opens_at',
      'closes_at',
      'is_open_now',
      'districts',
    ]);
    expect(second).toMatchObject({
      free_delivery_threshold_uzs: null,
      opens_at: '10:00',
      closes_at: '20:30',
      is_open_now: false,
    });
  });
});
