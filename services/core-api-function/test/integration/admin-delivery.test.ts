/** Admin delivery zones and slots over HTTP (port of test_admin_delivery_integration.py). */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db.ts';
import { createTestApp, hasDatabase, resetDatabase, testDatabase } from '../helpers/harness.ts';
import {
  addOrder,
  addSlot,
  addZone,
  adminCall,
  auditRows,
  customer,
  errorOf,
  jsonOf,
  staff,
  type Actor,
} from './admin-helpers.ts';

const ZONES = '/api/v1/admin/delivery/zones';
const SLOTS = '/api/v1/admin/delivery/slots';
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

const zoneBody = (overrides: Record<string, unknown> = {}) => ({
  slug: 'demo-new',
  name_uz: 'Demo yangi zona',
  name_ru: 'Демо новая зона',
  delivery_fee_uzs: 15_000,
  free_delivery_threshold_uzs: 400_000,
  min_order_uzs: 50_000,
  opens_at: '08:30',
  closes_at: '22:00',
  districts: ['sergeli', 'bektemir'],
  ...overrides,
});

const slotBody = (zoneId: string, overrides: Record<string, unknown> = {}) => ({
  zone_id: zoneId,
  slot_date: '2026-11-02',
  starts_at: '10:00',
  ends_at: '13:00',
  capacity: 8,
  cutoff_at: '2026-11-02T05:00:00Z',
  ...overrides,
});

describe.skipIf(!hasDatabase)('admin delivery', () => {
  const db = testDatabase() as Database;
  const app = createTestApp({ db });
  let admin: Actor;

  const req = (method: string, path: string, json?: unknown) =>
    adminCall(app, admin, method, path, json === undefined ? {} : { json });
  async function expectError(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    const error = await errorOf(response);
    expect(error.code).toBe(code);
    return error;
  }
  const districtsOf = async (zoneId: string) =>
    new Set(
      (
        await db.query<{ district: string }>(
          'SELECT district FROM delivery_zone_districts WHERE zone_id = $1',
          [zoneId],
        )
      ).rows.map((r) => r.district),
    );

  beforeEach(async () => {
    await resetDatabase(db);
    admin = await staff(db, 'admin');
  });

  it('creates and lists zones with ordered districts and an audit row', async () => {
    await addZone(db, 'demo-old', ['uchtepa']);
    await db.query(
      "UPDATE delivery_zones SET sort_order = 9, is_active = false WHERE slug = 'demo-old'",
    );
    const response = await req('POST', ZONES, zoneBody());
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const zone = await jsonOf(response);
    expect(Object.keys(zone)).toEqual([
      'id',
      'slug',
      'name_uz',
      'name_ru',
      'delivery_fee_uzs',
      'free_delivery_threshold_uzs',
      'min_order_uzs',
      'opens_at',
      'closes_at',
      'sort_order',
      'is_active',
      'districts',
      'created_at',
      'updated_at',
    ]);
    expect([zone.opens_at, zone.closes_at]).toEqual(['08:30', '22:00']);
    expect(zone.districts).toEqual([
      { code: 'bektemir', name_uz: 'Bektemir', name_ru: 'Бектемирский' },
      { code: 'sergeli', name_uz: 'Sergeli', name_ru: 'Сергелийский' },
    ]);
    const listing = (await jsonOf(req('GET', ZONES))).items;
    expect(listing.map((z: { slug: string }) => z.slug)).toEqual(['demo-new', 'demo-old']);
    expect(listing[1].is_active).toBe(false);

    const [audit] = await auditRows(db);
    expect([audit!.action, audit!.entity_type, audit!.entity_id, audit!.actor_user_id]).toEqual([
      'zone.create',
      'zone',
      zone.id,
      admin.user.id,
    ]);
    const changes = audit!.details['changes'] as Record<string, unknown>;
    expect(changes['districts']).toEqual({ from: null, to: 'bektemir,sergeli' });
    expect(changes['opens_at']).toEqual({ from: null, to: '08:30:00' });
    expect(changes['free_delivery_threshold_uzs']).toEqual({ from: null, to: 400_000 });
    expect([audit!.details['slug'], audit!.details['district_count']]).toEqual(['demo-new', 2]);
  });

  it('zone validation', async () => {
    for (const body of [
      zoneBody({ opens_at: '22:00', closes_at: '08:00' }),
      zoneBody({ opens_at: '9:00' }),
      zoneBody({ closes_at: '24:00' }),
      zoneBody({ districts: [] }),
      zoneBody({ districts: ['sergeli', 'sergeli'] }),
      zoneBody({ districts: ['tashkent'] }),
      zoneBody({ slug: 'Demo Zone' }),
      zoneBody({ name_uz: 'Demo\nzona' }),
      zoneBody({ delivery_fee_uzs: -1 }),
      zoneBody({ extra: 1 }),
    ]) {
      await expectError(await req('POST', ZONES, body), 422, 'validation_error');
    }
    const hours = await errorOf(
      await req('POST', ZONES, zoneBody({ opens_at: '22:00', closes_at: '08:00' })),
    );
    expect(hours.details).toEqual([
      { loc: ['body'], msg: 'Value error, opens_at must be before closes_at' },
    ]);
    const format = await errorOf(await req('POST', ZONES, zoneBody({ opens_at: '9:00' })));
    expect(format.details).toEqual([
      { loc: ['body', 'opens_at'], msg: 'Value error, must be a time as HH:MM (00:00-23:59)' },
    ]);
    const repeated = await errorOf(
      await req('POST', ZONES, zoneBody({ districts: ['sergeli', 'sergeli'] })),
    );
    expect(repeated.details).toEqual([
      { loc: ['body', 'districts'], msg: 'Value error, districts must not repeat' },
    ]);
    const empty = await errorOf(await req('POST', ZONES, zoneBody({ districts: [] })));
    expect(empty.details).toEqual([
      {
        loc: ['body', 'districts'],
        msg: 'List should have at least 1 item after validation, not 0',
      },
    ]);
    expect(await auditRows(db)).toEqual([]);
  });

  it('district and slug conflicts (district_taken carries the district)', async () => {
    await addZone(db, 'demo-taken', ['chilonzor']);
    const taken = await expectError(
      await req('POST', ZONES, zoneBody({ districts: ['sergeli', 'chilonzor'] })),
      409,
      'district_taken',
    );
    expect(taken).toEqual({
      code: 'district_taken',
      message: 'District belongs to another zone',
      district: 'chilonzor',
    });
    await expectError(
      await req('POST', ZONES, zoneBody({ slug: 'demo-taken', districts: ['sergeli'] })),
      409,
      'slug_taken',
    );
    const slugs = (await db.query<{ slug: string }>('SELECT slug FROM delivery_zones')).rows.map(
      (r) => r.slug,
    );
    expect(slugs).toEqual(['demo-taken']);
    expect(await auditRows(db)).toEqual([]);

    const created = await jsonOf(req('POST', ZONES, zoneBody({ districts: ['sergeli'] })));
    const patchTaken = await expectError(
      await req('PATCH', `${ZONES}/${created.id}`, { districts: ['chilonzor'] }),
      409,
      'district_taken',
    );
    expect(patchTaken['district']).toBe('chilonzor');
    await expectError(
      await req('PATCH', `${ZONES}/${created.id}`, { slug: 'demo-taken' }),
      409,
      'slug_taken',
    );
    expect(await districtsOf(created.id)).toEqual(new Set(['sergeli']));
  });

  it('PATCH changes only the fields sent', async () => {
    const created = await jsonOf(req('POST', ZONES, zoneBody()));
    const path = `${ZONES}/${created.id}`;
    const response = await req('PATCH', path, {
      name_uz: '  Demo nomi  ',
      free_delivery_threshold_uzs: null,
    });
    expect(response.status).toBe(200);
    const zone = await jsonOf(response);
    expect(zone.name_uz).toBe('Demo nomi');
    expect(zone.free_delivery_threshold_uzs).toBeNull();
    for (const key of [
      'name_ru',
      'delivery_fee_uzs',
      'min_order_uzs',
      'opens_at',
      'closes_at',
      'slug',
      'districts',
    ]) {
      expect(zone[key]).toEqual(created[key]);
    }
    const [, update] = await auditRows(db);
    expect(update!.action).toBe('zone.update');
    expect(update!.details['changes']).toEqual({
      free_delivery_threshold_uzs: { from: 400_000, to: null },
      name_uz: { from: 'Demo yangi zona', to: 'Demo nomi' },
    });

    expect((await req('PATCH', path, { name_uz: 'Demo nomi' })).status).toBe(200);
    expect((await req('PATCH', path, { opens_at: '08:30' })).status).toBe(200);
    expect((await req('PATCH', path, {})).status).toBe(200);
    expect(await auditRows(db)).toHaveLength(2);

    for (const nullBody of [
      { slug: null },
      { opens_at: null },
      { districts: null },
      { is_active: null },
    ]) {
      const refused = await expectError(
        await req('PATCH', path, nullBody),
        422,
        'validation_error',
      );
      expect(refused.details).toEqual([
        {
          loc: ['body', Object.keys(nullBody)[0]],
          msg: 'Value error, may be omitted but not null',
        },
      ]);
    }
    const hours = await expectError(
      await req('PATCH', path, { opens_at: '23:00' }),
      422,
      'validation_error',
    );
    expect(hours.details).toEqual([
      { loc: ['body', 'closes_at'], msg: 'opens_at must be before closes_at' },
    ]);
    expect(await auditRows(db)).toHaveLength(2);

    const replaced = await req('PATCH', path, {
      districts: ['sergeli', 'yangihayot'],
      is_active: false,
    });
    const replacedBody = await jsonOf(replaced);
    expect(replacedBody.districts.map((d: { code: string }) => d.code)).toEqual([
      'sergeli',
      'yangihayot',
    ]);
    expect(replacedBody.is_active).toBe(false);
    expect(await districtsOf(created.id)).toEqual(new Set(['sergeli', 'yangihayot']));
    expect(
      (await req('POST', ZONES, zoneBody({ slug: 'demo-other', districts: ['bektemir'] }))).status,
    ).toBe(201);
    const last = (await auditRows(db)).at(-2)!;
    expect((last.details['changes'] as Record<string, unknown>)['districts']).toEqual({
      from: 'bektemir,sergeli',
      to: 'sergeli,yangihayot',
    });
    expect((last.details['changes'] as Record<string, unknown>)['is_active']).toEqual({
      from: true,
      to: false,
    });
    await expectError(
      await req('PATCH', `${ZONES}/${UNKNOWN}`, { name_uz: 'X' }),
      404,
      'zone_not_found',
    );
  });

  it('deletes a free zone (districts cascade); zone_in_use with a slot or an order', async () => {
    const free = await jsonOf(req('POST', ZONES, zoneBody({ slug: 'demo-free' })));
    const response = await req('DELETE', `${ZONES}/${free.id}`);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(await districtsOf(free.id)).toEqual(new Set());
    const deleted = (await auditRows(db)).at(-1)!;
    expect([deleted.action, deleted.entity_id, deleted.details]).toEqual([
      'zone.delete',
      free.id,
      {
        changes: { districts: { from: 'bektemir,sergeli', to: null } },
        slug: 'demo-free',
        district_count: 2,
      },
    ]);
    await expectError(await req('DELETE', `${ZONES}/${free.id}`), 404, 'zone_not_found');

    const withSlot = await addZone(db, 'demo-slotted', ['olmazor']);
    await addSlot(db, withSlot);
    await expectError(await req('DELETE', `${ZONES}/${withSlot}`), 409, 'zone_in_use');
    const ordered = await addZone(db, 'demo-ordered', ['chilonzor']);
    await addOrder(db, admin.user.id, { zoneId: ordered });
    await expectError(await req('DELETE', `${ZONES}/${ordered}`), 409, 'zone_in_use');
    expect((await auditRows(db)).map((r) => r.action)).toEqual(['zone.create', 'zone.delete']);
  });

  it('creates and lists slots', async () => {
    const zone = await addZone(db, 'demo-slots', ['chilonzor']);
    const other = await addZone(db, 'demo-other', ['olmazor']);
    const response = await req('POST', SLOTS, slotBody(zone));
    expect(response.status).toBe(201);
    const slot = await jsonOf(response);
    expect(slot).toEqual({
      id: expect.any(String),
      zone_id: zone,
      slot_date: '2026-11-02',
      starts_at: '10:00',
      ends_at: '13:00',
      capacity: 8,
      reserved_count: 0,
      remaining: 8,
      cutoff_at: '2026-11-02T05:00:00Z',
      is_active: true,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(Object.keys(slot)).toEqual([
      'id',
      'zone_id',
      'slot_date',
      'starts_at',
      'ends_at',
      'capacity',
      'reserved_count',
      'remaining',
      'cutoff_at',
      'is_active',
      'created_at',
      'updated_at',
    ]);
    const later = await req(
      'POST',
      SLOTS,
      slotBody(zone, { slot_date: '2026-11-03', cutoff_at: '2026-11-03T10:00:00+05:00' }),
    );
    expect(later.status).toBe(201);
    const laterBody = await jsonOf(later);
    expect(laterBody.cutoff_at).toBe('2026-11-03T05:00:00Z');
    await addSlot(db, other, { date: '2026-11-02', startsAt: '09:00', endsAt: '10:00' });

    const audits = await auditRows(db, "action = 'slot.create'");
    const created = audits.find((r) => r.entity_id === slot.id)!;
    const changes = created.details['changes'] as Record<string, unknown>;
    expect(changes['capacity']).toEqual({ from: null, to: 8 });
    expect(changes['zone_id']).toEqual({ from: null, to: zone });
    expect(changes['cutoff_at']).toEqual({ from: null, to: '2026-11-02T05:00:00+00:00' });
    expect(changes['starts_at']).toEqual({ from: null, to: '10:00:00' });
    const offsetAudit = audits.find((r) => r.entity_id === laterBody.id)!;
    expect((offsetAudit.details['changes'] as Record<string, unknown>)['cutoff_at']).toEqual({
      from: null,
      to: '2026-11-03T10:00:00+05:00',
    });

    const everything = await jsonOf(req('GET', SLOTS));
    expect(
      everything.items.map((s: { slot_date: string; starts_at: string }) => [
        s.slot_date,
        s.starts_at,
      ]),
    ).toEqual([
      ['2026-11-02', '09:00'],
      ['2026-11-02', '10:00'],
      ['2026-11-03', '10:00'],
    ]);
    expect(everything.truncated).toBe(false);
    expect((await jsonOf(req('GET', `${SLOTS}?zone_id=${zone}`))).items).toHaveLength(2);
    const ranged = await jsonOf(req('GET', `${SLOTS}?date_from=2026-11-03&date_to=2026-11-03`));
    expect(ranged.items.map((s: { id: string }) => s.id)).toEqual([laterBody.id]);
    const backwards = await expectError(
      await req('GET', `${SLOTS}?date_from=2026-11-03&date_to=2026-11-02`),
      422,
      'validation_error',
    );
    expect(backwards.details).toEqual([
      { loc: ['query', 'date_to'], msg: 'date_to must not be before date_from' },
    ]);
    await expectError(await req('GET', `${SLOTS}?zone_id=nope`), 422, 'validation_error');
  });

  it('slot validation and conflicts', async () => {
    const zone = await addZone(db, 'demo-slots', ['chilonzor']);
    for (const body of [
      slotBody(zone, { cutoff_at: '2026-11-02T05:00:01Z' }),
      slotBody(zone, { cutoff_at: '2026-11-02T10:00:01+05:00' }),
      slotBody(zone, { cutoff_at: '2026-11-02T04:00:00' }),
      slotBody(zone, { starts_at: '13:00', ends_at: '13:00' }),
      slotBody(zone, { starts_at: '10:00:00' }),
      slotBody(zone, { capacity: -1 }),
      slotBody(zone, { reserved_count: 0 }),
    ]) {
      await expectError(await req('POST', SLOTS, body), 422, 'validation_error');
    }
    const naive = await errorOf(
      await req('POST', SLOTS, slotBody(zone, { cutoff_at: '2026-11-02T04:00:00' })),
    );
    expect(naive.details).toEqual([
      { loc: ['body', 'cutoff_at'], msg: 'Input should have timezone info' },
    ]);
    await expectError(await req('POST', SLOTS, slotBody(UNKNOWN)), 404, 'zone_not_found');
    expect((await req('POST', SLOTS, slotBody(zone))).status).toBe(201);
    await expectError(
      await req('POST', SLOTS, slotBody(zone, { ends_at: '12:00' })),
      409,
      'slot_exists',
    );
    expect((await auditRows(db)).map((r) => r.action)).toEqual(['slot.create']);
  });

  it('PATCH slot rules', async () => {
    const zone = await addZone(db, 'demo-slots', ['chilonzor']);
    const booked = await addSlot(db, zone, {
      date: '2026-11-02',
      startsAt: '10:00',
      endsAt: '13:00',
      capacity: 5,
      reserved: 3,
    });
    const path = `${SLOTS}/${booked}`;
    const below = await expectError(
      await req('PATCH', path, { capacity: 2 }),
      409,
      'capacity_below_reserved',
    );
    expect(below).toEqual({
      code: 'capacity_below_reserved',
      message: 'Capacity is below the places already booked',
    });
    for (const change of [
      { starts_at: '09:00' },
      { ends_at: '14:00' },
      { slot_date: '2026-11-03' },
    ]) {
      await expectError(await req('PATCH', path, change), 409, 'slot_in_use');
    }
    const response = await req('PATCH', path, {
      capacity: 3,
      is_active: false,
      cutoff_at: '2026-11-02T04:00:00Z',
    });
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect([body.capacity, body.remaining, body.reserved_count]).toEqual([3, 0, 3]);
    const update = (await auditRows(db)).at(-1)!;
    expect(update.action).toBe('slot.update');
    expect(update.details['changes']).toEqual({
      capacity: { from: 5, to: 3 },
      cutoff_at: { from: '2026-11-02T03:00:00+00:00', to: '2026-11-02T04:00:00+00:00' },
      is_active: { from: true, to: false },
    });
    await expectError(
      await req('PATCH', path, { cutoff_at: '2026-11-02T06:00:00Z' }),
      422,
      'validation_error',
    );
    // The same instant in another offset is no change at all.
    expect((await req('PATCH', path, { cutoff_at: '2026-11-02T09:00:00+05:00' })).status).toBe(200);
    expect((await auditRows(db)).filter((r) => r.action === 'slot.update')).toHaveLength(1);

    const free = await addSlot(db, zone, {
      date: '2026-11-02',
      startsAt: '15:00',
      endsAt: '18:00',
    });
    const freePath = `${SLOTS}/${free}`;
    const cutoff = await expectError(
      await req('PATCH', freePath, { starts_at: '11:00' }),
      422,
      'validation_error',
    );
    expect(cutoff.details).toEqual([
      { loc: ['body', 'cutoff_at'], msg: 'cutoff_at must not be after the slot starts' },
    ]);
    await expectError(
      await req('PATCH', freePath, { starts_at: '10:00', cutoff_at: '2026-11-02T04:00:00Z' }),
      409,
      'slot_exists',
    );
    const order = await expectError(
      await req('PATCH', freePath, { ends_at: '14:00' }),
      422,
      'validation_error',
    );
    expect(order.details).toEqual([
      { loc: ['body', 'ends_at'], msg: 'starts_at must be before ends_at' },
    ]);
    const moved = await req('PATCH', freePath, {
      slot_date: '2026-11-04',
      starts_at: '16:00',
      ends_at: '19:00',
    });
    expect(moved.status).toBe(200);
    const movedBody = await jsonOf(moved);
    expect([movedBody.slot_date, movedBody.starts_at]).toEqual(['2026-11-04', '16:00']);
    for (const bad of [{ capacity: null }, { zone_id: zone }, { reserved_count: 0 }]) {
      await expectError(await req('PATCH', freePath, bad), 422, 'validation_error');
    }
    await expectError(
      await req('PATCH', `${SLOTS}/${UNKNOWN}`, { capacity: 1 }),
      404,
      'slot_not_found',
    );
    expect((await auditRows(db)).map((r) => r.action)).toEqual(['slot.update', 'slot.update']);
  });

  it('deletes a free slot; slot_in_use when booked or referenced by an order', async () => {
    const zone = await addZone(db, 'demo-slots', ['chilonzor']);
    const booked = await addSlot(db, zone, { reserved: 1 });
    await expectError(await req('DELETE', `${SLOTS}/${booked}`), 409, 'slot_in_use');
    const referenced = await addSlot(db, zone, { startsAt: '15:00', endsAt: '16:00' });
    await addOrder(db, admin.user.id, { status: 'CANCELLED', zoneId: zone, slotId: referenced });
    await expectError(await req('DELETE', `${SLOTS}/${referenced}`), 409, 'slot_in_use');
    const free = await addSlot(db, zone, { startsAt: '18:00', endsAt: '19:00' });
    expect((await req('DELETE', `${SLOTS}/${free}`)).status).toBe(204);
    expect((await db.query('SELECT 1 FROM delivery_slots WHERE id = $1', [free])).rows).toEqual([]);
    const [deleted] = await auditRows(db, "action = 'slot.delete'");
    expect(deleted!.entity_id).toBe(free);
    const changes = deleted!.details['changes'] as Record<string, unknown>;
    expect(changes['starts_at']).toEqual({ from: '18:00:00', to: null });
    expect(changes['zone_id']).toEqual({ from: zone, to: null });
    await expectError(await req('DELETE', `${SLOTS}/${free}`), 404, 'slot_not_found');
  });

  it('operators and customers are refused before anything happens', async () => {
    const zone = await addZone(db, 'demo-slots', ['chilonzor']);
    const slot = await addSlot(db, zone);
    for (const actor of [await staff(db, 'operator'), await customer(db)]) {
      const calls: Array<[string, string, unknown?]> = [
        ['GET', ZONES],
        ['POST', ZONES, zoneBody()],
        ['PATCH', `${ZONES}/${zone}`, { name_uz: 'X' }],
        ['PATCH', `${ZONES}/${UNKNOWN}`, { name_uz: 'X' }],
        ['DELETE', `${ZONES}/${zone}`],
        ['GET', SLOTS],
        ['POST', SLOTS, slotBody(zone)],
        ['PATCH', `${SLOTS}/${slot}`, { capacity: 1 }],
        ['DELETE', `${SLOTS}/${slot}`],
        ['DELETE', `${SLOTS}/${UNKNOWN}`],
      ];
      for (const [method, path, json] of calls) {
        const response = await adminCall(
          app,
          actor,
          method,
          path,
          json === undefined ? {} : { json },
        );
        expect(response.status, `${method} ${path}`).toBe(403);
        expect((await errorOf(response)).message).toBe('Admin role required');
      }
    }
    expect(await auditRows(db)).toEqual([]);
    expect((await db.query('SELECT 1 FROM delivery_slots')).rows).toHaveLength(1);
  });
});
