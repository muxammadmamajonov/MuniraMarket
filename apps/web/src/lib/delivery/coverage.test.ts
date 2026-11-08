import type { DeliveryZone } from '@muniramarket/contracts';
import { describe, expect, it } from 'vitest';
import { farZone, zone } from '@/lib/checkout/test-fixtures';
import { coverageFor, isDemoZone, isNearTashkent, servedNeighbours } from './coverage';

// Served: yunusobod, mirobod (central), chilonzor (far).
const ZONES: DeliveryZone[] = [zone(), farZone()];
const CITY: [number, number] = [69.2797, 41.3111];
const SAMARKAND: [number, number] = [66.9597, 39.6542];

describe('coverageFor', () => {
  it('served: the zone that really delivers to the district', () => {
    const result = coverageFor(ZONES, { kind: 'district', code: 'chilonzor' }, CITY);
    expect(result).toMatchObject({ status: 'served', district: { code: 'chilonzor' } });
    expect(result.status === 'served' && result.zone.slug).toBe('demo-chekka');
  });

  it('not served: names the district and suggests served neighbours first', () => {
    const result = coverageFor(ZONES, { kind: 'district', code: 'yakkasaroy' }, CITY);
    expect(result.status).toBe('not-served');
    if (result.status !== 'not-served') return;
    expect(result.code).toBe('yakkasaroy');
    // yakkasaroy borders mirobod and chilonzor (both served), then any served district.
    expect(result.nearby.map((d) => d.code)).toEqual(['mirobod', 'chilonzor', 'yunusobod']);
  });

  it('never suggests the district itself, and copes with no served zones', () => {
    expect(servedNeighbours([], 'bektemir')).toEqual([]);
    expect(servedNeighbours(ZONES, 'mirobod').map((d) => d.code)).not.toContain('mirobod');
  });

  it('outside only when results never mention Tashkent and the point is far away', () => {
    expect(coverageFor(ZONES, { kind: 'elsewhere' }, SAMARKAND)).toEqual({ status: 'outside' });
    expect(coverageFor(ZONES, { kind: 'elsewhere' }, CITY)).toEqual({ status: 'unknown' });
  });

  it('unknown when the city is known but the district is not, or nothing came back', () => {
    expect(coverageFor(ZONES, { kind: 'city' }, CITY)).toEqual({ status: 'unknown' });
    expect(coverageFor(ZONES, { kind: 'nothing' }, SAMARKAND)).toEqual({ status: 'unknown' });
  });

  it('lookup-failed when there was no lookup: never "served"', () => {
    expect(coverageFor(ZONES, null, CITY)).toEqual({ status: 'lookup-failed' });
  });
});

describe('helpers', () => {
  it('isNearTashkent', () => {
    expect(isNearTashkent(CITY)).toBe(true);
    expect(isNearTashkent(SAMARKAND)).toBe(false);
  });

  it('isDemoZone: only seeded demo- slugs', () => {
    expect(isDemoZone({ slug: 'demo-markaziy' })).toBe(true);
    expect(isDemoZone({ slug: 'markaziy' })).toBe(false);
    expect(isDemoZone({ slug: 'markaziy-demo' })).toBe(false);
  });
});
