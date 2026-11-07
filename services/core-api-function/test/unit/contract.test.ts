import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../src/errors.ts';
import { registered } from '../../src/routes/index.ts';
import { createTestApp } from '../helpers/harness.ts';

/**
 * API parity with the contract: packages/contracts/openapi.json is generated from the FastAPI
 * reference (CI regenerates it and fails on drift), and the TypeScript client types are generated
 * from it. The Function must serve exactly those operations, plus the one Function-only internal
 * route the Cloudflare cron calls (never reachable from a browser or the public hostname).
 */

interface OpenApi {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: { ApiErrorBody: { properties: { code: { enum: string[] } } } } };
}

const openapi = JSON.parse(
  readFileSync(new URL('../../../../packages/contracts/openapi.json', import.meta.url), 'utf8'),
) as OpenApi;

const FUNCTION_ONLY = new Set(['POST /api/v1/internal/scheduler/notifications/drain']);

function contractOperations(): string[] {
  const ops: string[] = [];
  for (const [path, item] of Object.entries(openapi.paths)) {
    for (const method of Object.keys(item)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        ops.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return ops.sort();
}

describe('OpenAPI contract parity', () => {
  createTestApp(); // registers every route module

  it('serves every operation of the contract and nothing undocumented', () => {
    const served = registered.map((r) => `${r.method} ${r.path}`);
    const missing = contractOperations().filter((op) => !served.includes(op));
    const extra = served.filter(
      (op) => !contractOperations().includes(op) && !FUNCTION_ONLY.has(op),
    );
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('keeps the error code enum identical to the contract', () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [...openapi.components.schemas.ApiErrorBody.properties.code.enum].sort(),
    );
  });
});
