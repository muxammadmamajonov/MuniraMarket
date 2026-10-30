import { describe, expect, it } from 'vitest';
import openapi from '../openapi.json';
import { API_ERROR_CODES, PRODUCT_SORTS } from './api';
import { PRODUCT_UNITS, USER_ROLES } from './enums';
import { SUPPORTED_LOCALES } from './locale';

/**
 * Guards the hand-kept runtime lists (and the schema names `src/api.ts` aliases) against the
 * OpenAPI document the types are generated from. `pnpm contracts:generate` refreshes both.
 */
const schemas = openapi.components.schemas as Record<string, unknown>;

interface EnumSchema {
  enum: string[];
}

function enumOf(name: string): string[] {
  const schema = schemas[name] as EnumSchema | undefined;
  if (schema === undefined) throw new Error(`schema ${name} missing from openapi.json`);
  return schema.enum;
}

describe('openapi.json', () => {
  it('API_ERROR_CODES equals the ErrorCode enum of ApiErrorBody', () => {
    const body = schemas['ApiErrorBody'] as { properties: { code: EnumSchema } };
    expect([...API_ERROR_CODES].sort()).toEqual([...body.properties.code.enum].sort());
  });

  it('PRODUCT_SORTS equals the ProductSort enum, in the same order', () => {
    expect([...PRODUCT_SORTS]).toEqual(enumOf('ProductSort'));
  });

  it('shared enums match the API', () => {
    expect([...USER_ROLES].sort()).toEqual([...enumOf('UserRole')].sort());
    expect([...PRODUCT_UNITS].sort()).toEqual([...enumOf('Unit')].sort());
    expect([...SUPPORTED_LOCALES].sort()).toEqual([...enumOf('Language')].sort());
  });

  it.each([
    // errors
    'ApiErrorBody',
    'ErrorDetail',
    'ErrorEnvelope',
    // catalog
    'CategoryNode',
    'CategoryRef',
    'CategoryTree',
    'ProductSummary',
    'ProductDetail',
    'ProductPage',
    'ProductSort',
    'Unit',
    // cart
    'Cart',
    'CartLine',
    'AddCartItemRequest',
    'SetCartItemQuantityRequest',
    // auth
    'UserPublic',
    'SessionResponse',
    'InitDataRequest',
    'LoginWidgetRequest',
    'AuthConfigResponse',
  ])('declares the %s schema', (name) => {
    expect(Object.keys(schemas)).toContain(name);
  });

  it('mounts every public route under the v1 prefix', () => {
    const paths = Object.keys(openapi.paths);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.startsWith('/api/v1/')).toBe(true);
  });
});
