import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { WarehouseConnector } from '../../../src/domain/warehouse.ts';

const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('warehouse seam (port of test_warehouse_seam.py)', () => {
  it('declares the four connector operations', () => {
    const connector: WarehouseConnector = {
      fetchStock: async () => [],
      reserve: async (request) => ({ reservationId: 'r', idempotencyKey: request.idempotencyKey }),
      commit: async () => undefined,
      cancel: async () => undefined,
    };
    expect(Object.keys(connector).sort()).toEqual(['cancel', 'commit', 'fetchStock', 'reserve']);
  });

  it('is intentionally unwired', () => {
    const importers = files(SRC).filter(
      (path) =>
        !path.endsWith('warehouse.ts') && readFileSync(path, 'utf8').includes('warehouse.ts'),
    );
    expect(importers).toEqual([]);
  });
});
