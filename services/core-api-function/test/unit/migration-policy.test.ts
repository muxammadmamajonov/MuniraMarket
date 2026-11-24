import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Expand-then-contract (architecture/0019): migrations run BEFORE the new Function is deployed,
 * so for a while the old Function runs against the new schema. A migration that removes or
 * tightens something the old release still reads must be a deliberate, later "contract" release.
 *
 * Revisions up to and including 0009 are grandfathered (0007 and 0009 broke that rule). Every
 * newer revision whose upgrade() drops or tightens anything must carry a marker line:
 *
 *   # contract: <what the previous release already stopped using>
 */
const VERSIONS = join(import.meta.dirname, '../../../api/alembic/versions');
const LAST_GRANDFATHERED = 9;
const DESTRUCTIVE =
  /op\.(drop_table|drop_column|drop_constraint|drop_index|alter_column)\(|\bDROP\s+(TABLE|COLUMN|CONSTRAINT|TYPE)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i;

function revisions() {
  return readdirSync(VERSIONS)
    .filter((f) => /^\d{8}_\d{4}_\d{4}_.+\.py$/.test(f))
    .sort()
    .map((file) => ({
      file,
      number: Number(/^\d{8}_\d{4}_(\d{4})_/.exec(file)?.[1]),
      source: readFileSync(join(VERSIONS, file), 'utf8'),
    }));
}

function upgradeBody(source: string): string {
  const start = source.indexOf('def upgrade(');
  if (start === -1) return '';
  const end = source.indexOf('def downgrade(', start);
  return source.slice(start, end === -1 ? undefined : end);
}

describe('migration policy', () => {
  it('finds the revisions in numeric order', () => {
    const numbers = revisions().map((r) => r.number);
    expect(numbers.length).toBeGreaterThanOrEqual(9);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it('requires a contract marker on any newer revision that removes or tightens something', () => {
    const offenders = revisions()
      .filter((r) => r.number > LAST_GRANDFATHERED)
      .filter((r) => DESTRUCTIVE.test(upgradeBody(r.source)))
      .filter((r) => !/^# contract: \S/m.test(r.source))
      .map((r) => r.file);
    expect(offenders, 'add "# contract: <what the previous release stopped using>"').toEqual([]);
  });

  it('detects what it should (the grandfathered 0007 and 0009 are destructive)', () => {
    const destructive = revisions()
      .filter((r) => DESTRUCTIVE.test(upgradeBody(r.source)))
      .map((r) => r.number);
    expect(destructive).toContain(7);
    expect(destructive).toContain(9);
  });
});
