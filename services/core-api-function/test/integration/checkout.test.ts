/** Checkout quote over HTTP (port of the quote cases in test_orders_integration.py and slots). */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db.ts';
import { createTestApp, hasDatabase, resetDatabase, testDatabase } from '../helpers/harness.ts';
import {
  addCategory,
  addProduct,
  addSlot,
  addToCart,
  addZone,
  as,
  customer,
  errorOf,
  type Customer,
} from './catalog.seed.ts';

const QUOTE = '/api/v1/checkout/quote';

describe.skipIf(!hasDatabase)('checkout quote', () => {
  const db = testDatabase() as Database;
  const app = createTestApp({ db });
  let me: Customer;
  let category: string;
  let zone: string;

  const quote = (district = 'chilonzor') => as(app, me).post(QUOTE, { district });

  beforeEach(async () => {
    await resetDatabase(db);
    me = await customer(db);
    category = await addCategory(db, 'q-cat');
    zone = await addZone(db, 'demo-markaziy', ['chilonzor', 'olmazor']);
    await addZone(db, 'demo-yopiq', ['bektemir'], { isActive: false });
  });

  it('prices delivery for the matching zone with the reference shape', async () => {
    const apple = await addProduct(db, category, 'apple', { price: 30_000, stock: 5 });
    await addToCart(app, me, apple, 2);
    const response = await quote('olmazor');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      'items',
      'item_count',
      'subtotal_uzs',
      'delivery_fee_uzs',
      'total_uzs',
      'free_delivery_remaining_uzs',
      'zone',
      'issues',
      'can_place_order',
      'slot_required',
      'delivery_slots',
    ]);
    expect(body).toMatchObject({
      item_count: 2,
      subtotal_uzs: 60_000,
      delivery_fee_uzs: 15_000,
      total_uzs: 75_000,
      free_delivery_remaining_uzs: 240_000,
      issues: [],
      can_place_order: true,
      slot_required: false,
      delivery_slots: [],
      zone: { slug: 'demo-markaziy' },
    });
  });

  it('refuses unserved districts and validates the district', async () => {
    for (const district of ['bektemir', 'sergeli']) {
      await errorOf(await quote(district), 409, 'district_not_served');
    }
    await errorOf(await quote('tashkent'), 422, 'validation_error');
  });

  it('reports the threshold, the minimum order and an empty cart as issues', async () => {
    let body = (await (await quote()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      issues: ['cart_empty'],
      can_place_order: false,
      total_uzs: 15_000,
    });
    const small = await addProduct(db, category, 'small', { price: 20_000, stock: null });
    await addToCart(app, me, small, 1);
    body = (await (await quote()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ issues: ['below_min_order'], can_place_order: false });
    await addToCart(app, me, small, 14);
    body = (await (await quote()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      subtotal_uzs: 300_000,
      delivery_fee_uzs: 0,
      free_delivery_remaining_uzs: 0,
      issues: [],
    });
  });

  it('offers the bookable slots of the zone and requires one', async () => {
    const later = await addSlot(db, zone, {
      daysAhead: 2,
      startsAt: '14:00',
      endsAt: '16:00',
      capacity: 3,
      reserved: 1,
    });
    const sooner = await addSlot(db, zone, {
      daysAhead: 1,
      startsAt: '10:00',
      endsAt: '12:00',
      capacity: 2,
      reserved: 2,
    });
    await addSlot(db, zone, { daysAhead: 1, startsAt: '18:00', endsAt: '19:00', isActive: false });
    await addSlot(db, zone, { daysAhead: 1, startsAt: '08:00', cutoffPassed: true });
    await addSlot(db, zone, { daysAhead: 14, startsAt: '10:00' }); // beyond the offer window
    const body = (await (await quote()).json()) as {
      slot_required: boolean;
      delivery_slots: unknown[];
    };
    expect(body.slot_required).toBe(true);
    expect(body.delivery_slots).toEqual([
      {
        id: sooner,
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        starts_at: '10:00',
        ends_at: '12:00',
        remaining: 0,
        is_full: true,
      },
      {
        id: later,
        date: expect.any(String),
        starts_at: '14:00',
        ends_at: '16:00',
        remaining: 2,
        is_full: false,
      },
    ]);
  });

  it('requires a session and the CSRF token', async () => {
    const anonymous = await as(app, {
      ...me,
      session: { ...me.session, cookie: 'mm_session=nope' },
    }).post(QUOTE, {
      district: 'chilonzor',
    });
    await errorOf(anonymous, 401, 'session_required');
    const noCsrf = await as(app, { ...me, session: { ...me.session, writeHeaders: {} } }).post(
      QUOTE,
      {
        district: 'chilonzor',
      },
    );
    await errorOf(noCsrf, 403, 'csrf_failed');
  });
});
