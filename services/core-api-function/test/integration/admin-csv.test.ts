/** Catalog CSV template/export/import over HTTP (port of test_admin_csv_integration.py). */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db.ts';
import { BOM, COLUMNS, EXPORT_COLUMNS } from '../../src/domain/catalogCsv.ts';
import { createTestApp, hasDatabase, resetDatabase, testDatabase } from '../helpers/harness.ts';
import {
  addCategory,
  addProduct,
  adminCall,
  auditRows,
  errorOf,
  jsonOf,
  staff,
  type Actor,
} from './admin-helpers.ts';

const IMPORT = '/api/v1/admin/catalog/csv/import';
const EXPORT = '/api/v1/admin/catalog/csv/export';
const TEMPLATE = '/api/v1/admin/catalog/csv/template';

type Cells = Record<string, string>;

const csvRow = (overrides: Cells = {}): Cells => ({
  sku: 'DEMO-NEW',
  slug: '',
  category_slug: 'mevalar',
  name_uz: 'Demo yangi',
  name_ru: 'Демо новый',
  description_uz: '',
  description_ru: '',
  unit: 'kg',
  price_uzs: '9000',
  old_price_uzs: '',
  stock_quantity: '10',
  is_active: 'true',
  sort_order: '0',
  image_url: '',
  ...overrides,
});

const quote = (value: string) =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
function toCsv(rows: Cells[], header: readonly string[] = COLUMNS): Uint8Array {
  const lines = [
    header.join(','),
    ...rows.map((r) => header.map((c) => quote(r[c] ?? '')).join(',')),
  ];
  return new TextEncoder().encode(`${BOM}${lines.join('\r\n')}\r\n`);
}

describe.skipIf(!hasDatabase)('admin catalog CSV', () => {
  const db = testDatabase() as Database;
  const app = createTestApp({ db, clock: () => Date.parse('2026-11-06T20:30:00Z') / 1000 });
  let admin: Actor;
  let fruit: string;
  let vegetables: string;

  const upload = (raw: Uint8Array | string, query = '', contentType = 'text/csv') =>
    adminCall(app, admin, 'POST', `${IMPORT}${query}`, {
      body: raw,
      headers: { 'content-type': contentType },
    });
  const products = async () =>
    (
      await db.query(
        `SELECT sku, slug, category_id::text AS category_id, price_uzs, old_price_uzs, stock_quantity,
                is_active, updated_at FROM products ORDER BY sku`,
      )
    ).rows;
  const auditCount = async () => (await auditRows(db)).length;

  beforeEach(async () => {
    await resetDatabase(db);
    admin = await staff(db, 'admin');
    fruit = await addCategory(db, 'mevalar');
    vegetables = await addCategory(db, 'sabzavotlar');
  });

  async function seed() {
    await addProduct(db, fruit, 'DEMO-OLMA', { slug: 'olma', price: 12_000, stock: 5 });
    await addProduct(db, vegetables, 'DEMO-PIYOZ', { slug: 'piyoz', price: 4_000 });
  }

  it('the template: exact bytes and headers', async () => {
    const response = await adminCall(app, admin, 'GET', TEMPLATE);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="catalog-template.csv"',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toBe(
      `${EXPORT_COLUMNS.map((c) => `"${c}"`).join(',')}\r\n`,
    );
  });

  it('a bad row among valid ones writes nothing', async () => {
    await seed();
    const before = await products();
    const response = await upload(
      toCsv([
        csvRow(),
        csvRow({ sku: 'DEMO-OLMA', slug: 'olma', price_uzs: '13000' }),
        csvRow({ sku: 'DEMO-BAD', price_uzs: '12,5' }),
        csvRow({ sku: 'DEMO-NEW2' }),
      ]),
    );
    expect(response.status).toBe(200);
    const result = await jsonOf(response);
    expect(result).toMatchObject({ applied: false, dry_run: false, total_rows: 4 });
    expect(result.errors).toEqual([
      {
        row: 3,
        column: 'price_uzs',
        code: 'invalid_money',
        message: 'Whole UZS: digits only, at most 10^12',
      },
    ]);
    expect(await products()).toEqual(before);
    expect(await auditCount()).toBe(0);
  });

  it('database-level errors write nothing', async () => {
    await seed();
    await addProduct(db, fruit, 'DEMO-ESKI', { slug: 'eski', archived: true });
    const before = await products();
    const result = await jsonOf(
      upload(
        toCsv([
          csvRow(),
          csvRow({ sku: 'DEMO-X', category_slug: 'yoq' }),
          csvRow({ sku: 'DEMO-ESKI' }),
          csvRow({ sku: 'DEMO-Y', slug: 'piyoz' }),
        ]),
      ),
    );
    expect(result.applied).toBe(false);
    expect(result.errors.map((e: { row: number; code: string }) => [e.row, e.code])).toEqual([
      [2, 'category_not_found'],
      [3, 'product_archived'],
      [4, 'slug_taken'],
    ]);
    expect(await products()).toEqual(before);
    expect(await auditCount()).toBe(0);
  });

  it('dry_run never writes', async () => {
    await seed();
    const before = await products();
    const response = await upload(
      toCsv([csvRow(), csvRow({ sku: 'DEMO-OLMA', slug: 'olma', price_uzs: '13000' })]),
      '?dry_run=true',
    );
    expect(await jsonOf(response)).toEqual({
      dry_run: true,
      applied: false,
      total_rows: 2,
      creates: 1,
      updates: 1,
      unchanged: 0,
      errors: [],
      errors_truncated: false,
    });
    expect(await products()).toEqual(before);
    expect(await auditCount()).toBe(0);
  });

  it('a clean import creates and updates in one transaction with audit rows', async () => {
    await seed();
    const raw = toCsv([
      csvRow(),
      csvRow({
        sku: 'DEMO-OLMA',
        slug: 'olma',
        name_uz: 'Demo DEMO-OLMA',
        name_ru: 'Демо DEMO-OLMA',
        unit: 'piece',
        price_uzs: '13000',
        old_price_uzs: '16000',
        stock_quantity: '',
        category_slug: 'sabzavotlar',
      }),
    ]);
    const response = await upload(raw);
    expect(response.status).toBe(200);
    const result = await jsonOf(response);
    expect([result.applied, result.creates, result.updates]).toEqual([true, 1, 1]);
    const rows = await products();
    const created = rows.find((r) => r['sku'] === 'DEMO-NEW')!;
    const updated = rows.find((r) => r['sku'] === 'DEMO-OLMA')!;
    expect(created).toMatchObject({ slug: 'demo-new', stock_quantity: 10 });
    expect(updated).toMatchObject({
      price_uzs: 13_000,
      old_price_uzs: 16_000,
      stock_quantity: null,
      category_id: vegetables,
    });

    const audit = await auditRows(db);
    expect(audit.map((r) => r.action)).toEqual([
      'product.create',
      'product.update',
      'catalog.import',
    ]);
    expect(audit[0]!.details['source']).toBe('csv');
    expect((audit[0]!.details['changes'] as Record<string, unknown>)['sku']).toEqual({
      from: null,
      to: 'DEMO-NEW',
    });
    expect(audit[1]!.details).toEqual({
      changes: {
        category_id: { from: fruit, to: vegetables },
        price_uzs: { from: 12_000, to: 13_000 },
        old_price_uzs: { from: null, to: 16_000 },
        stock_quantity: { from: 5, to: null },
      },
      source: 'csv',
      sku: 'DEMO-OLMA',
    });
    expect(audit[2]!.details).toEqual({
      source: 'csv',
      rows: 2,
      creates: 1,
      updates: 1,
      unchanged: 0,
    });
    expect(audit[2]!.actor_user_id).toBe(admin.user.id);

    const again = await jsonOf(upload(raw));
    expect([again.applied, again.creates, again.updates, again.unchanged]).toEqual([true, 0, 0, 2]);
    expect(await auditCount()).toBe(4);
  });

  it('export then import is unchanged; formulas are escaped', async () => {
    await seed();
    const tricky = [
      '=HYPERLINK("https://evil.example","bosing")',
      "+cmd|' /C calc'!A0",
      '@SUM(1+1)',
      '-2+3',
      "'qo'shtirnoq",
    ];
    for (const [index, name] of tricky.entries()) {
      const response = await adminCall(app, admin, 'POST', '/api/v1/admin/products', {
        json: {
          sku: `DEMO-T${index}`,
          slug: `demo-t${index}`,
          category_id: fruit,
          name_uz: name,
          name_ru: name,
          description_uz: `${name}\nikkinchi qator`,
          unit: 'piece',
          price_uzs: 1000 + index,
          image_url: 'https://cdn.example.com/t.png',
        },
      });
      expect(response.status).toBe(201);
    }
    await addProduct(db, fruit, 'DEMO-ARXIV', { slug: 'arxiv', archived: true });

    const exported = await adminCall(app, admin, 'GET', EXPORT);
    expect(exported.status).toBe(200);
    // The clock is 2026-11-06 20:30 UTC = 2026-11-07 01:30 in Tashkent.
    expect(exported.headers.get('content-disposition')).toBe(
      'attachment; filename="catalog-20261107.csv"',
    );
    expect(exported.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const bytes = new Uint8Array(await exported.arrayBuffer());
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    expect(text.startsWith(BOM)).toBe(true);
    expect(text).not.toContain('DEMO-ARXIV');
    expect(text.slice(1).startsWith('"sku","slug",')).toBe(true);
    expect(text).toContain('"\'=HYPERLINK(""https://evil.example"",""bosing"")"');
    expect(text).toMatch(/"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00"\r\n$/);

    const before = await products();
    const auditBefore = await auditCount();
    const result = await jsonOf(upload(bytes));
    expect(result.errors).toEqual([]);
    expect([result.applied, result.creates, result.updates, result.unchanged]).toEqual([
      true,
      0,
      0,
      tricky.length + 2,
    ]);
    expect(await products()).toEqual(before);
    expect(await auditCount()).toBe(auditBefore + 1);
  });

  it('a file exported before an order took stock is stale', async () => {
    await seed();
    const exported = new Uint8Array(
      await (await adminCall(app, admin, 'GET', EXPORT)).arrayBuffer(),
    );
    await db.query(
      "UPDATE products SET stock_quantity = 4, updated_at = now() WHERE sku = 'DEMO-OLMA'",
    );
    const result = await jsonOf(upload(exported));
    expect(result.applied).toBe(false);
    expect(result.errors).toEqual([
      {
        row: 1,
        column: 'updated_at',
        code: 'stale_row',
        message: 'The product changed after this file was exported; export again',
      },
    ]);
  });

  it('file errors and limits', async () => {
    const header = await upload('sku,price\r\n1,2\r\n');
    expect(header.status).toBe(422);
    const headerError = await errorOf(header);
    expect(headerError.code).toBe('csv_invalid_header');
    expect(headerError.details).toContainEqual({ loc: ['body', 'missing'], msg: 'slug' });
    expect(headerError.details).toContainEqual({ loc: ['body', 'unknown'], msg: 'price' });

    const encoding = await upload(new Uint8Array([0x73, 0x6b, 0x75, 0xff]));
    expect(await errorOf(encoding)).toEqual({
      code: 'csv_invalid_encoding',
      message: "The file is not UTF-8 (save it as 'CSV UTF-8')",
      details: [],
    });
    const malformed = await upload(`${COLUMNS.join(',')}\r\nDEMO-1,"demo,1\r\n`);
    expect(malformed.status).toBe(422);
    expect((await errorOf(malformed)).code).toBe('csv_malformed');

    const rows = Array.from({ length: 2001 }, (_, i) =>
      csvRow({ sku: `DEMO-${i}`, slug: `demo-${i}` }),
    );
    const tooMany = await upload(toCsv(rows));
    expect(tooMany.status).toBe(422);
    expect((await errorOf(tooMany)).code).toBe('csv_too_many_rows');

    const tooLarge = await upload('x'.repeat(1024 * 1024 + 1));
    expect(tooLarge.status).toBe(413);
    expect((await errorOf(tooLarge)).code).toBe('payload_too_large');

    const wrongType = await upload(toCsv([csvRow()]), '', 'application/json');
    expect(wrongType.status).toBe(415);
    expect((await errorOf(wrongType)).code).toBe('unsupported_media_type');
    const appCsv = await upload(toCsv([csvRow()]), '?dry_run=1', 'application/csv; charset=utf-8');
    expect(appCsv.status).toBe(200);

    const badQuery = await upload(toCsv([csvRow()]), '?dry_run=maybe');
    expect((await errorOf(badQuery)).details).toEqual([
      {
        loc: ['query', 'dry_run'],
        msg: 'Input should be a valid boolean, unable to interpret input',
      },
    ]);
    expect(await products()).toEqual([]);
  });

  it('more than 200 errors are truncated', async () => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      csvRow({ sku: `DEMO-${i}`, slug: `demo-${i}`, unit: 'box' }),
    );
    const result = await jsonOf(upload(toCsv(rows)));
    expect(result.errors).toHaveLength(200);
    expect(result.errors_truncated).toBe(true);
    expect(result.errors[199].row).toBe(200);
  });

  it('only admins (and only with CSRF for import)', async () => {
    const operator = await staff(db, 'operator');
    for (const [method, path] of [
      ['GET', TEMPLATE],
      ['GET', EXPORT],
      ['POST', IMPORT],
    ] as const) {
      const response = await adminCall(
        app,
        operator,
        method,
        path,
        method === 'POST' ? { body: 'x', headers: { 'content-type': 'text/csv' } } : {},
      );
      expect(response.status).toBe(403);
    }
    const noCsrf = await adminCall(app, admin, 'POST', IMPORT, {
      body: toCsv([csvRow()]),
      headers: { 'content-type': 'text/csv' },
      noCsrf: true,
    });
    expect(noCsrf.status).toBe(403);
    expect((await errorOf(noCsrf)).code).toBe('csrf_failed');
  });
});
