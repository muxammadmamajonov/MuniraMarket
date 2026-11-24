import { describe, expect, it } from 'vitest';
import {
  BOM,
  COLUMNS,
  CsvFileError,
  deriveSlug,
  escapeCell,
  EXPORT_COLUMNS,
  MAX_ROWS,
  parseAwareIsoMicros,
  parseCatalogCsv,
  planImport,
  referencedSlugs,
  renderCsv,
  renderTemplate,
  countKind,
  type CatalogSnapshot,
  type CsvRow,
  type ExistingProduct,
  type ExportRow,
  type ProductValue,
} from '../../../src/domain/catalogCsv.ts';

const CATEGORY_ID = '0b8f6a52-7c1e-4e0e-9d0e-5c8d2f1b7a10';
const UPDATED_AT_CELL = '2026-10-31T07:15:30.123456+00:00';
const UPDATED_AT = parseAwareIsoMicros(UPDATED_AT_CELL) as bigint;

type Cells = Record<string, string>;

function row(overrides: Cells = {}): Cells {
  return {
    sku: 'DEMO-0001',
    slug: 'demo-olma',
    category_slug: 'mevalar',
    name_uz: 'Demo olma',
    name_ru: 'Демо яблоко',
    description_uz: '',
    description_ru: '',
    unit: 'kg',
    price_uzs: '12000',
    old_price_uzs: '',
    stock_quantity: '',
    is_active: 'true',
    sort_order: '0',
    image_url: '',
    ...overrides,
  };
}

/** Python `csv.writer` (QUOTE_MINIMAL). */
function quoteMinimal(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function toCsv(
  rows: Cells[],
  options: { header?: readonly string[]; bom?: boolean; newline?: string } = {},
): Uint8Array {
  const columns = options.header ?? COLUMNS;
  const newline = options.newline ?? '\r\n';
  const lines = [columns.map(quoteMinimal).join(',')];
  for (const values of rows)
    lines.push(columns.map((column) => quoteMinimal(values[column] ?? '')).join(','));
  return new TextEncoder().encode(
    (options.bom === false ? '' : BOM) + lines.join(newline) + newline,
  );
}

const enc = (text: string) => new TextEncoder().encode(text);

function singleError(raw: Uint8Array): [string | null, string] {
  const parsed = parseCatalogCsv(raw);
  expect(parsed.rows).toEqual([]);
  expect(parsed.errors).toHaveLength(1);
  const error = parsed.errors[0];
  expect(error?.row).toBe(1);
  return [error?.column ?? null, error?.code ?? ''];
}

function fileError(raw: Uint8Array): CsvFileError {
  try {
    parseCatalogCsv(raw);
  } catch (error) {
    if (error instanceof CsvFileError) return error;
    throw error;
  }
  throw new Error('expected a CsvFileError');
}

describe('parsing', () => {
  it('parses a valid row', () => {
    const parsed = parseCatalogCsv(
      toCsv([
        row({
          description_uz: 'Birinchi qator\nIkkinchi\tqator',
          old_price_uzs: '15000',
          stock_quantity: '7',
          is_active: 'FALSE',
          sort_order: '-5',
          image_url: 'https://cdn.example.com/olma.webp',
          unit: 'KG',
        }),
      ]),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.total_rows).toBe(1);
    expect(parsed.rows).toEqual([
      {
        row: 1,
        sku: 'DEMO-0001',
        slug: 'demo-olma',
        category_slug: 'mevalar',
        name_uz: 'Demo olma',
        name_ru: 'Демо яблоко',
        description_uz: 'Birinchi qator\nIkkinchi\tqator',
        description_ru: null,
        unit: 'kg',
        price_uzs: 12_000,
        old_price_uzs: 15_000,
        stock_quantity: 7,
        is_active: false,
        sort_order: -5,
        image_url: 'https://cdn.example.com/olma.webp',
        updated_at: null,
        safety_stock: null,
      },
    ]);
  });

  for (const bom of [true, false]) {
    for (const newline of ['\r\n', '\n', '\r']) {
      it(`BOM optional, any line ending (bom=${bom}, ${JSON.stringify(newline)})`, () => {
        const parsed = parseCatalogCsv(
          toCsv([row(), row({ sku: 'DEMO-0002', slug: 'demo-nok' })], { bom, newline }),
        );
        expect(parsed.errors).toEqual([]);
        expect(parsed.rows.map((r) => r.sku)).toEqual(['DEMO-0001', 'DEMO-0002']);
      });
    }
  }

  it('CRLF inside a quoted description becomes a newline', () => {
    const parsed = parseCatalogCsv(toCsv([row({ description_ru: 'яблоко\r\n яблоко' })]));
    expect(parsed.rows[0]?.description_ru).toBe('яблоко\n яблоко');
  });

  it('columns may come in any order; blank lines are skipped', () => {
    const raw = toCsv([row()], { header: [...COLUMNS].reverse() });
    const parsed = parseCatalogCsv(new Uint8Array([...raw, ...enc('\r\n\r\n')]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.total_rows).toBe(1);
  });

  it('header names are trimmed', () => {
    const header = COLUMNS.map((column) => ` ${column} `).join(',');
    const body = new TextDecoder()
      .decode(toCsv([row()], { bom: false }))
      .split('\r\n')
      .slice(1)
      .join('\r\n');
    const parsed = parseCatalogCsv(enc(`${header}\r\n${body}`));
    expect(parsed.errors).toEqual([]);
    expect(parsed.total_rows).toBe(1);
  });

  it('a fully quoted file imports', () => {
    const header = COLUMNS.map((column) => `"${column}"`).join(',');
    const cells = COLUMNS.map((column) => `"${row()[column]}"`).join(',');
    const parsed = parseCatalogCsv(enc(`${BOM}${header}\r\n${cells}\r\n`));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]?.old_price_uzs).toBeNull();
  });
});

describe('file-level errors', () => {
  it.each([
    new Uint8Array([0x73, 0x6b, 0x75, 0x0a, 0xdf, 0xe1, 0xeb]), // cp1251
    new Uint8Array([0xff, 0xfe, 0x73, 0x00, 0x6b, 0x00, 0x75, 0x00]),
    new Uint8Array([...enc('sku,slug\n'), 0xc3, 0x28]),
  ])('not UTF-8 is csv_invalid_encoding (%#)', (raw) => {
    expect(fileError(raw).code).toBe('csv_invalid_encoding');
  });

  it('NUL bytes are refused', () => {
    expect(fileError(toCsv([row({ name_uz: 'Demo\x00olma' })])).code).toBe('csv_invalid_encoding');
  });

  it('missing, unknown and duplicate columns are listed', () => {
    const header = [...COLUMNS.filter((c) => c !== 'price_uzs'), 'brand', 'sku'];
    const error = fileError(toCsv([], { header }));
    expect(error.code).toBe('csv_invalid_header');
    expect(error.message).toBe(
      `The header must be exactly: ${COLUMNS.join(',')} (optionally ,safety_stock and ,updated_at)`,
    );
    expect(error.details).toEqual([
      ['duplicate', 'sku'],
      ['missing', 'price_uzs'],
      ['unknown', 'brand'],
    ]);
  });

  it('long or unprintable unknown names are echoed safely', () => {
    const error = fileError(toCsv([], { header: [...COLUMNS, `x\u200b${'y'.repeat(80)}`] }));
    const echoed = error.details[0]?.[1] ?? '';
    expect(echoed.startsWith('x?y')).toBe(true);
    expect([...echoed]).toHaveLength(64);
    expect(echoed.endsWith('…')).toBe(true);
  });

  it.each([new Uint8Array(), enc(BOM), enc('\r\n\r\n')])(
    'an empty file is an invalid header (%#)',
    (raw) => {
      const error = fileError(raw);
      expect(error.code).toBe('csv_invalid_header');
      expect(error.details).toContainEqual(['missing', 'sku']);
    },
  );

  it.each(['DEMO-1,"demo,1', 'DEMO-1,"de"mo,x'])(
    'strict quoting errors are csv_malformed: %s',
    (line) => {
      const error = fileError(enc(`${COLUMNS.join(',')}\r\n${line}\r\n`));
      expect(error.code).toBe('csv_malformed');
      expect(error.message).toMatch(/^Malformed CSV near line \d+$/);
    },
  );

  it('a wrong number of fields is csv_malformed', () => {
    const error = fileError(enc(`${COLUMNS.join(',')}\r\nDEMO-1,demo-1\r\n`));
    expect(error.code).toBe('csv_malformed');
    expect(error.message).toBe(`Row 1 has 2 fields, expected ${COLUMNS.length}`);
  });

  it('2000 rows are fine, 2001 are too many', () => {
    const rows = Array.from({ length: MAX_ROWS }, (_, i) =>
      row({ sku: `DEMO-${String(i).padStart(5, '0')}`, slug: `demo-${i}` }),
    );
    expect(parseCatalogCsv(toCsv(rows)).total_rows).toBe(MAX_ROWS);
    rows.push(row({ sku: 'DEMO-LAST', slug: 'demo-last' }));
    expect(fileError(toCsv(rows)).code).toBe('csv_too_many_rows');
  });
});

describe('row errors', () => {
  it.each([
    [{ sku: '' }, 'sku', 'required'],
    [{ sku: '-DEMO' }, 'sku', 'invalid_sku'],
    [{ sku: 'DEMO 1' }, 'sku', 'invalid_sku'],
    [{ sku: 'D'.repeat(65) }, 'sku', 'invalid_sku'],
    [{ slug: 'Demo-Olma' }, 'slug', 'invalid_slug'],
    [{ slug: 'demo--olma' }, 'slug', 'invalid_slug'],
    [{ slug: 'a'.repeat(129) }, 'slug', 'invalid_slug'],
    [{ category_slug: '' }, 'category_slug', 'required'],
    [{ category_slug: 'Mevalar!' }, 'category_slug', 'invalid_slug'],
    [{ name_uz: '' }, 'name_uz', 'required'],
    [{ name_ru: '   ' }, 'name_ru', 'required'],
    [{ name_uz: 'x'.repeat(256) }, 'name_uz', 'invalid_text'],
    [{ name_uz: 'Ikki\nqator' }, 'name_uz', 'invalid_text'],
    [{ name_uz: 'Demo\x07' }, 'name_uz', 'invalid_text'],
    [{ description_uz: 'x'.repeat(5001) }, 'description_uz', 'invalid_text'],
    [{ description_uz: 'bad\x1bescape' }, 'description_uz', 'invalid_text'],
    [{ name_ru: 'Ð¯Ð±Ð»Ð¾ÐºÐ¾' }, 'name_ru', 'invalid_text'],
    [{ name_uz: 'Ã¼zum' }, 'name_uz', 'invalid_text'],
    [{ description_ru: 'Itâ€™s' }, 'description_ru', 'invalid_text'],
    [{ name_ru: 'Ябл\ufffdко' }, 'name_ru', 'invalid_text'],
    [{ name_uz: 'Olma\u202egnp.exe' }, 'name_uz', 'invalid_text'],
    [{ name_ru: 'Ol\u200bma' }, 'name_ru', 'invalid_text'],
    [{ name_uz: '\ufeffOlma' }, 'name_uz', 'invalid_text'],
    [{ name_uz: 'Olma\u2066x\u2069' }, 'name_uz', 'invalid_text'],
    [{ name_uz: 'Olma\u2028nok' }, 'name_uz', 'invalid_text'],
    [{ name_uz: 'Olma\u3164' }, 'name_uz', 'invalid_text'],
    [{ description_uz: 'Shirin\n\u202eolma' }, 'description_uz', 'invalid_text'],
    [{ description_ru: 'Shirin\u00adolma' }, 'description_ru', 'invalid_text'],
    [{ unit: '' }, 'unit', 'required'],
    [{ unit: 'box' }, 'unit', 'invalid_unit'],
    [{ price_uzs: '' }, 'price_uzs', 'required'],
    [{ price_uzs: '12000.50' }, 'price_uzs', 'invalid_money'],
    [{ price_uzs: '12 000' }, 'price_uzs', 'invalid_money'],
    [{ price_uzs: '-1' }, 'price_uzs', 'invalid_money'],
    [{ price_uzs: '+1' }, 'price_uzs', 'invalid_money'],
    [{ price_uzs: '1000000000001' }, 'price_uzs', 'invalid_money'],
    [{ price_uzs: '١٢' }, 'price_uzs', 'invalid_money'],
    [{ old_price_uzs: '1e5' }, 'old_price_uzs', 'invalid_money'],
    [{ old_price_uzs: '12000' }, 'old_price_uzs', 'invalid_old_price'],
    [{ old_price_uzs: '100' }, 'old_price_uzs', 'invalid_old_price'],
    [{ stock_quantity: '-1' }, 'stock_quantity', 'invalid_stock'],
    [{ stock_quantity: '1000001' }, 'stock_quantity', 'invalid_stock'],
    [{ stock_quantity: '2.5' }, 'stock_quantity', 'invalid_stock'],
    [{ is_active: '' }, 'is_active', 'required'],
    [{ is_active: 'yes' }, 'is_active', 'invalid_bool'],
    [{ sort_order: '100001' }, 'sort_order', 'invalid_sort_order'],
    [{ sort_order: '1.5' }, 'sort_order', 'invalid_sort_order'],
    [{ image_url: 'http://cdn.example.com/a.png' }, 'image_url', 'invalid_image_url'],
    [{ image_url: 'https://127.0.0.1/a.png' }, 'image_url', 'invalid_image_url'],
    [{ image_url: 'https://localhost/a.png' }, 'image_url', 'invalid_image_url'],
    [{ image_url: 'https://user:pw@cdn.example.com/a' }, 'image_url', 'invalid_image_url'],
    [{ image_url: 'javascript:alert(1)' }, 'image_url', 'invalid_image_url'],
  ])('%j -> %s %s', (overrides, column, code) => {
    expect(singleError(toCsv([row(overrides)]))).toEqual([column, code]);
  });

  it('image URL messages carry the validator text', () => {
    const parsed = parseCatalogCsv(toCsv([row({ image_url: 'http://cdn.example.com/a.png' })]));
    expect(parsed.errors[0]?.message).toBe('Image URL must use https');
  });

  for (const column of ['name_uz', 'name_ru', 'description_uz', 'description_ru']) {
    it.each([
      '=HYPERLINK("https://evil.example","click")',
      "+cmd|' /C calc'!A0",
      '@SUM(1+1)',
      '\t=1',
      '\r=1',
      ' =1+2',
    ])(`formula injection is refused in ${column}: %j`, (value) => {
      expect(singleError(toCsv([row({ [column]: value })]))).toEqual([
        column,
        'formula_not_allowed',
      ]);
    });
  }

  it.each([
    ["'=SUM(1)", '=SUM(1)'],
    ["'+998", '+998'],
    ["'@home", '@home'],
    ["'-2+3", '-2+3'],
    ["''quoted", "'quoted"],
    ['-20% chegirma', '-20% chegirma'],
    ["'plain", "'plain"],
  ])('escaped cells are unescaped once: %j', (cell, stored) => {
    const parsed = parseCatalogCsv(toCsv([row({ name_uz: cell })]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]?.name_uz).toBe(stored);
  });

  it('duplicate SKUs in one file', () => {
    const parsed = parseCatalogCsv(toCsv([row(), row({ slug: 'other' }), row({ slug: 'third' })]));
    expect(parsed.errors.map((e) => [e.row, e.code])).toEqual([
      [2, 'duplicate_sku'],
      [3, 'duplicate_sku'],
    ]);
    expect(parsed.rows.map((r) => r.row)).toEqual([1]);
  });

  it('every bad cell of a row is reported, in column order', () => {
    const parsed = parseCatalogCsv(
      toCsv([row({ price_uzs: 'x', unit: 'box', is_active: 'maybe' })]),
    );
    expect(parsed.errors.map((e) => [e.column, e.code])).toEqual([
      ['unit', 'invalid_unit'],
      ['price_uzs', 'invalid_money'],
      ['is_active', 'invalid_bool'],
    ]);
  });

  it('descriptions keep newlines and ordinary unicode', () => {
    const parsed = parseCatalogCsv(
      toCsv([
        row({ name_uz: "O'zbek olma — 1 kg 🍎", description_uz: 'Birinchi\nikkinchi\tqator' }),
      ]),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]?.name_uz).toBe("O'zbek olma — 1 kg 🍎");
  });

  it('updated_at is optional and parsed', () => {
    expect(parseCatalogCsv(toCsv([row()])).rows[0]?.updated_at).toBeNull();
    const header = EXPORT_COLUMNS;
    expect(
      parseCatalogCsv(toCsv([row({ updated_at: '' })], { header })).rows[0]?.updated_at,
    ).toBeNull();
    expect(
      parseCatalogCsv(toCsv([row({ updated_at: UPDATED_AT_CELL })], { header })).rows[0]
        ?.updated_at,
    ).toBe(UPDATED_AT);
    const reordered = parseCatalogCsv(
      toCsv([row({ updated_at: UPDATED_AT_CELL })], { header: [...header].reverse() }),
    );
    expect(reordered.rows[0]?.updated_at).toBe(UPDATED_AT);
    expect(parseAwareIsoMicros('2026-10-31T12:15:30.123456+05:00')).toBe(UPDATED_AT);
    expect(parseAwareIsoMicros('2026-10-31T07:15:30.123456Z')).toBe(UPDATED_AT);
  });

  it.each([
    'yesterday',
    '2026-10-31',
    '2026-10-31T07:15:30',
    '=NOW()',
    '2026-02-30T00:00:00+00:00',
  ])('invalid updated_at %j', (cell) => {
    expect(singleError(toCsv([row({ updated_at: cell })], { header: EXPORT_COLUMNS }))).toEqual([
      'updated_at',
      'invalid_updated_at',
    ]);
  });

  it('updated_at twice is an invalid header', () => {
    const error = fileError(toCsv([row()], { header: [...EXPORT_COLUMNS, 'updated_at'] }));
    expect(error.code).toBe('csv_invalid_header');
    expect(error.details).toContainEqual(['duplicate', 'updated_at']);
  });

  it('empty optional cells', () => {
    const [parsed] = parseCatalogCsv(toCsv([row({ slug: '', sort_order: '' })])).rows;
    expect(parsed?.slug).toBeNull();
    expect(parsed?.sort_order).toBe(0);
    expect(parsed?.stock_quantity).toBeNull();
    expect(parsed?.image_url).toBeNull();
  });
});

// --- planning -------------------------------------------------------------------------------------

function parsedRows(...rows: Cells[]): CsvRow[] {
  const parsed = parseCatalogCsv(toCsv(rows));
  expect(parsed.errors).toEqual([]);
  return parsed.rows;
}

let nextId = 0;
function existing(
  sku = 'DEMO-0001',
  options: { archived?: boolean; updatedAt?: bigint; values?: Record<string, ProductValue> } = {},
): ExistingProduct {
  nextId += 1;
  return {
    id: `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
    sku,
    archived: options.archived ?? false,
    updated_at: options.updatedAt ?? UPDATED_AT,
    values: {
      slug: 'demo-olma',
      category_id: CATEGORY_ID,
      name_uz: 'Demo olma',
      name_ru: 'Демо яблоко',
      description_uz: null,
      description_ru: null,
      unit: 'kg',
      price_uzs: 12_000,
      old_price_uzs: null,
      stock_quantity: null,
      safety_stock: 0,
      is_active: true,
      sort_order: 0,
      image_url: null,
      ...options.values,
    },
  };
}

function snapshot(...products: ExistingProduct[]): CatalogSnapshot {
  return {
    products_by_sku: new Map(products.map((p) => [p.sku, p])),
    slug_owners: new Map(products.map((p) => [String(p.values['slug']), p.sku])),
    category_ids: new Map([['mevalar', CATEGORY_ID]]),
  };
}

describe('planning', () => {
  it('classifies creates, updates and unchanged', () => {
    const rows = parsedRows(
      row(),
      row({ sku: 'DEMO-0002', slug: 'demo-nok', price_uzs: '9000' }),
      row({ sku: 'DEMO-0003', slug: '' }),
    );
    const changed = existing('DEMO-0002', {
      values: { slug: 'demo-nok', price_uzs: 8_000, stock_quantity: 4 },
    });
    const plan = planImport(rows, snapshot(existing(), changed));
    expect(plan.errors).toEqual([]);
    expect(plan.changes.map((c) => [c.sku, c.kind])).toEqual([
      ['DEMO-0001', 'unchanged'],
      ['DEMO-0002', 'update'],
      ['DEMO-0003', 'create'],
    ]);
    expect(plan.changes[1]?.product_id).toBe(changed.id);
    expect(plan.changes[1]?.changes).toEqual({
      price_uzs: [8_000, 9_000],
      stock_quantity: [4, null],
    });
    expect(plan.changes[2]?.values['slug']).toBe('demo-0003');
    expect(plan.changes[2]?.changes['price_uzs']).toEqual([null, 12_000]);
    expect([
      countKind(plan, 'create'),
      countKind(plan, 'update'),
      countKind(plan, 'unchanged'),
    ]).toEqual([1, 1, 1]);
  });

  it('an empty slug keeps the existing one', () => {
    const plan = planImport(parsedRows(row({ slug: '' })), snapshot(existing()));
    expect(plan.changes[0]?.kind).toBe('unchanged');
    expect(plan.changes[0]?.values).not.toHaveProperty('slug');
  });

  it.each([
    [[row({ category_slug: 'nonexistent' })], [], [[1, 'category_slug', 'category_not_found']]],
    [[row()], [existing('DEMO-0001', { archived: true })], [[1, 'sku', 'product_archived']]],
    [[row({ sku: 'DEMO-NEW' })], [existing()], [[1, 'slug', 'slug_taken']]],
    [
      [row({ sku: 'DEMO-A', slug: 'same' }), row({ sku: 'DEMO-B', slug: 'same' })],
      [],
      [[2, 'slug', 'slug_taken']],
    ],
    [
      [row({ sku: 'DEMO-A', slug: '' }), row({ sku: 'DEMO-B', slug: 'demo-a' })],
      [],
      [[2, 'slug', 'slug_taken']],
    ],
  ] as Array<[Cells[], ExistingProduct[], unknown[]]>)(
    'plan errors (%#)',
    (rows, products, expected) => {
      const plan = planImport(parsedRows(...rows), snapshot(...products));
      expect(plan.errors.map((e) => [e.row, e.column, e.code])).toEqual(expected);
    },
  );

  const stamped = (...rows: Cells[]) => {
    const parsed = parseCatalogCsv(toCsv(rows, { header: EXPORT_COLUMNS }));
    expect(parsed.errors).toEqual([]);
    return parsed.rows;
  };

  it('a row exported before the product changed is stale', () => {
    const rows = stamped(row({ stock_quantity: '10', updated_at: UPDATED_AT_CELL }));
    const changed = existing('DEMO-0001', {
      values: { stock_quantity: 9 },
      updatedAt: UPDATED_AT + 1n,
    });
    const plan = planImport(rows, snapshot(changed));
    expect(plan.errors.map((e) => [e.row, e.column, e.code, e.message])).toEqual([
      [
        1,
        'updated_at',
        'stale_row',
        'The product changed after this file was exported; export again',
      ],
    ]);
    expect(plan.changes).toEqual([]);
  });

  it('a current updated_at (any offset) imports normally', () => {
    const rows = stamped(
      row({ stock_quantity: '10', updated_at: '2026-10-31T12:15:30.123456+05:00' }),
    );
    const plan = planImport(
      rows,
      snapshot(existing('DEMO-0001', { values: { stock_quantity: 9 } })),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.changes[0]?.changes).toEqual({ stock_quantity: [9, 10] });
  });

  it('an empty updated_at overwrites on purpose; unknown SKU with one is stale', () => {
    const rows = stamped(
      row({ stock_quantity: '10', updated_at: '' }),
      row({ sku: 'DEMO-NEW', slug: 'demo-new' }),
    );
    const plan = planImport(
      rows,
      snapshot(existing('DEMO-0001', { updatedAt: UPDATED_AT + 86_400_000_000n })),
    );
    expect(plan.changes.map((c) => c.kind)).toEqual(['update', 'create']);
    const gone = planImport(
      stamped(row({ sku: 'DEMO-GONE', updated_at: UPDATED_AT_CELL })),
      snapshot(),
    );
    expect(gone.errors.map((e) => [e.column, e.code])).toEqual([['updated_at', 'stale_row']]);
  });

  it('deriveSlug and referencedSlugs', () => {
    expect(deriveSlug('DEMO_0001.a')).toBe('demo-0001-a');
    expect(deriveSlug('x--Y')).toBe('x-y');
    expect(deriveSlug('...')).toBeNull();
    expect(referencedSlugs(parsedRows(row(), row({ sku: 'DEMO-9', slug: '' })))).toEqual(
      new Set(['demo-olma', 'demo-9']),
    );
  });
});

// --- export ---------------------------------------------------------------------------------------

function exportRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    sku: 'DEMO-0001',
    slug: 'demo-olma',
    category_slug: 'mevalar',
    name_uz: 'Demo olma',
    name_ru: 'Демо яблоко',
    description_uz: null,
    description_ru: 'яблоко\n яблоко',
    unit: 'kg',
    price_uzs: 12_000,
    old_price_uzs: 15_000,
    stock_quantity: 0,
    safety_stock: 2,
    is_active: false,
    sort_order: -3,
    image_url: 'https://cdn.example.com/a.png',
    updated_at: UPDATED_AT_CELL,
    ...overrides,
  };
}

const decode = (raw: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw);

describe('export', () => {
  it('format: BOM, quoted header, CRLF, every cell quoted', () => {
    const text = decode(renderCsv([exportRow()]));
    expect(text.startsWith(BOM)).toBe(true);
    expect(text.slice(1).startsWith(`${EXPORT_COLUMNS.map((c) => `"${c}"`).join(',')}\r\n`)).toBe(
      true,
    );
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text).toContain(
      '"DEMO-0001","demo-olma","mevalar","Demo olma","Демо яблоко","","яблоко\n яблоко","kg",' +
        '"12000","15000","0","2","false","-3","https://cdn.example.com/a.png",' +
        '"2026-10-31T07:15:30.123456+00:00"\r\n',
    );
  });

  it('the template is the header only', () => {
    const header = EXPORT_COLUMNS.map((c) => `"${c}"`).join(',');
    expect(decode(renderTemplate())).toBe(`${BOM}${header}\r\n`);
    expect(parseCatalogCsv(renderTemplate()).total_rows).toBe(0);
  });

  it.each([
    ['=HYPERLINK("https://evil.example","x")', '\'=HYPERLINK("https://evil.example","x")'],
    ['+cmd', "'+cmd"],
    ['-2+3', "'-2+3"],
    ['@SUM(1)', "'@SUM(1)"],
    ['\t=1', "'\t=1"],
    ["'quoted", "''quoted"],
    ['Demo', 'Demo'],
    ['', ''],
  ])('escapeCell(%j)', (value, escaped) => {
    expect(escapeCell(value)).toBe(escaped);
  });

  it.each([
    '=HYPERLINK("https://evil.example","click")',
    '+cmd',
    '@SUM(1+1)',
    '-2+3',
    "'quoted",
    "'=already",
    'Oddiy nom, vergul va "qo\'shtirnoq"',
    'Olma;=1+1',
  ])('export then import round-trips %j', (name) => {
    const raw = renderCsv([
      exportRow({ name_uz: name, description_uz: name, description_ru: null }),
    ]);
    const parsed = parseCatalogCsv(raw);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]?.name_uz).toBe(name);
    expect(parsed.rows[0]?.description_uz).toBe(name);
    expect(parsed.rows[0]?.updated_at).toBe(UPDATED_AT);
  });
});

// --- safety stock (ADR 0018) ----------------------------------------------------------------------

describe('safety stock column', () => {
  const header = [...COLUMNS, 'safety_stock'];

  it('is optional and exported right after stock_quantity', () => {
    expect(COLUMNS).not.toContain('safety_stock');
    expect(EXPORT_COLUMNS.indexOf('safety_stock')).toBe(
      EXPORT_COLUMNS.indexOf('stock_quantity') + 1,
    );
    expect(parsedRows(row())[0]?.safety_stock).toBeNull();
  });

  it.each([
    ['', 0],
    ['0', 0],
    [' 3 ', 3],
    ['1000000', 1_000_000],
  ])('cell %j -> %d', (cell, expected) => {
    const parsed = parseCatalogCsv(toCsv([row({ safety_stock: cell })], { header }));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]?.safety_stock).toBe(expected);
  });

  it.each(['-1', '1.5', 'abc', '1000001'])('refuses %j', (cell) => {
    expect(singleError(toCsv([row({ safety_stock: cell })], { header }))).toEqual([
      'safety_stock',
      'invalid_safety_stock',
    ]);
  });

  it('without the column the product keeps its safety stock; a new one starts at 0', () => {
    const plan = planImport(
      parsedRows(row(), row({ sku: 'DEMO-NEW', slug: 'demo-new' })),
      snapshot(existing('DEMO-0001', { values: { safety_stock: 4 } })),
    );
    expect(plan.errors).toEqual([]);
    const [unchanged, created] = plan.changes;
    expect(unchanged?.kind).toBe('unchanged');
    expect(unchanged?.values).not.toHaveProperty('safety_stock');
    expect(created?.values['safety_stock']).toBe(0);
  });

  it('with the column the safety stock is updated', () => {
    const parsed = parseCatalogCsv(toCsv([row({ safety_stock: '2' })], { header }));
    const plan = planImport(
      parsed.rows,
      snapshot(existing('DEMO-0001', { values: { safety_stock: 4 } })),
    );
    expect(plan.changes[0]?.changes).toEqual({ safety_stock: [4, 2] });
  });
});
