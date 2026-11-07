/**
 * Catalog CSV import/export: pure parsing, validation, planning and rendering (port of
 * services/api/app/domain/catalog_csv.py; no database).
 *
 * Format (template, export and import share it):
 * - UTF-8 with a byte-order mark and CRLF line endings; on import the BOM is optional.
 * - The columns in `COLUMNS`, then `updated_at` (`EXPORT_COLUMNS`). An import may order them
 *   differently, but every column of `COLUMNS` must be present exactly once, `updated_at` at most
 *   once, and nothing else.
 * - RFC 4180 quoting, parsed exactly like Python's `csv` module in strict mode (a stray quote is
 *   an error, not a silently merged field). Export quotes every cell.
 *
 * Lost updates: `updated_at` is the product's last change as exported (UTC, microseconds). When an
 * imported row carries one and the product's current `updated_at` differs, the row is refused
 * (`stale_row`).
 *
 * Formula injection: a text cell beginning with `= + - @ \t \r` (or `'`) is prefixed with `'` on
 * export; import strips exactly one such `'` again. An unescaped imported text cell beginning
 * with `= + @ \t \r` is refused (`formula_not_allowed`); a leading `-` is ordinary text.
 */

import { InvalidImageUrlError, validateImageUrl } from './imageUrl.ts';
import { hasInvisibleCharacters, pyLen, pyStrip } from './text.ts';

export const UNITS = ['piece', 'kg', 'g', 'l', 'ml'] as const;
export type Unit = (typeof UNITS)[number];

export const COLUMNS = [
  'sku',
  'slug',
  'category_slug',
  'name_uz',
  'name_ru',
  'description_uz',
  'description_ru',
  'unit',
  'price_uzs',
  'old_price_uzs',
  'stock_quantity',
  'is_active',
  'sort_order',
  'image_url',
] as const;
/** Optional on import; always written by export and the template (last column). */
export const OPTIONAL_COLUMNS = ['updated_at'] as const;
export const EXPORT_COLUMNS = [...COLUMNS, ...OPTIONAL_COLUMNS] as const;
export type Column = (typeof EXPORT_COLUMNS)[number];

export const MAX_ROWS = 2000;
export const MAX_ERRORS = 200;
export const MAX_NAME_LENGTH = 255;
export const MAX_DESCRIPTION_LENGTH = 5000;
export const MAX_SLUG_LENGTH = 128;
export const MAX_PRICE_UZS = 10 ** 12;
export const MAX_STOCK = 1_000_000;
export const MIN_SORT_ORDER = -100_000;
export const MAX_SORT_ORDER = 100_000;
/** Longest unknown header name echoed back in an error. */
const MAX_ECHO = 64;
/** Python's `csv.field_size_limit()` default. */
const FIELD_SIZE_LIMIT = 131_072;

export const BOM = '\ufeff';
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MONEY = /^[0-9]{1,13}$/;
const STOCK = /^[0-9]{1,7}$/;
const SORT = /^-?[0-9]{1,6}$/;
const TRUE = new Set(['true', '1']);
const FALSE = new Set(['false', '0']);

export const EXPORT_ESCAPE_TRIGGERS: ReadonlySet<string> = new Set([
  '=',
  '+',
  '-',
  '@',
  '\t',
  '\r',
  "'",
]);
export const IMPORT_FORMULA_START: ReadonlySet<string> = new Set(['=', '+', '@', '\t', '\r']);
// Control characters: names allow none; descriptions allow `\n` and `\t`.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_MULTILINE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
// UTF-8 text decoded as Latin-1 / Windows-1252 ("Привет" read that way starts with U+00D0
// U+0178). Uzbek and Russian text never contains these pairs.
const MOJIBAKE = new RegExp(
  '[\\u00c2\\u00c3\\u00d0\\u00d1]' +
    '[\\u0080-\\u00bf\\u0152\\u0153\\u0160\\u0161\\u0178\\u017d\\u017e\\u0192\\u02c6\\u02dc' +
    '\\u2013\\u2014\\u2018-\\u201e\\u2020-\\u2022\\u2026\\u2030\\u2039\\u203a\\u20ac\\u2122]' +
    '|\\u00e2\\u20ac',
);

export type RowErrorCode =
  | 'required'
  | 'invalid_sku'
  | 'duplicate_sku'
  | 'invalid_slug'
  | 'slug_taken'
  | 'category_not_found'
  | 'invalid_money'
  | 'invalid_old_price'
  | 'invalid_stock'
  | 'invalid_unit'
  | 'invalid_bool'
  | 'invalid_sort_order'
  | 'invalid_text'
  | 'formula_not_allowed'
  | 'invalid_image_url'
  | 'invalid_updated_at'
  | 'product_archived'
  | 'stale_row';
export type FileErrorCode =
  'csv_invalid_encoding' | 'csv_invalid_header' | 'csv_malformed' | 'csv_too_many_rows';

// --- errors ---------------------------------------------------------------------------------------

/** `row` is the 1-based data row (the header is row 0). */
export interface CsvRowError {
  row: number;
  column: Column | null;
  code: RowErrorCode;
  message: string;
}

/** The file as a whole is unusable; nothing is validated row by row. */
export class CsvFileError extends Error {
  readonly code: FileErrorCode;
  /** `[location, message]` pairs, e.g. `['missing', 'price_uzs']`. */
  readonly details: ReadonlyArray<readonly [string, string]>;
  constructor(
    code: FileErrorCode,
    message: string,
    details: ReadonlyArray<readonly [string, string]> = [],
  ) {
    super(message);
    this.name = 'CsvFileError';
    this.code = code;
    this.details = details;
  }
}

class CellError extends Error {
  readonly code: RowErrorCode;
  constructor(code: RowErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// --- parsed rows ----------------------------------------------------------------------------------

export interface CsvRow {
  row: number;
  sku: string;
  /** `null`: keep the existing product's slug, or derive one from the SKU for a new one. */
  slug: string | null;
  category_slug: string;
  name_uz: string;
  name_ru: string;
  description_uz: string | null;
  description_ru: string | null;
  unit: Unit;
  price_uzs: number;
  old_price_uzs: number | null;
  stock_quantity: number | null;
  is_active: boolean;
  sort_order: number;
  image_url: string | null;
  /** `updated_at` as exported, in epoch microseconds; `null`: no staleness check. */
  updated_at: bigint | null;
}

export interface ParsedCsv {
  rows: CsvRow[];
  errors: CsvRowError[];
  total_rows: number;
}

/** UTF-8 text without the BOM. Refuses other encodings and NUL bytes. */
export function decodeCsv(raw: Uint8Array): string {
  if (raw.includes(0))
    throw new CsvFileError('csv_invalid_encoding', 'The file contains NUL bytes');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new CsvFileError(
      'csv_invalid_encoding',
      "The file is not UTF-8 (save it as 'CSV UTF-8')",
    );
  }
  return text.startsWith(BOM) ? text.slice(1) : text;
}

const NOT_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/** A header name safe to show back: printable (Python `isprintable`) and short. */
function echo(name: string): string {
  const cleaned = [...name].map((ch) => (ch !== ' ' && NOT_PRINTABLE.test(ch) ? '?' : ch));
  return cleaned.length <= MAX_ECHO
    ? cleaned.join('')
    : `${cleaned.slice(0, MAX_ECHO - 1).join('')}…`;
}

const EXPORT_COLUMN_SET: ReadonlySet<string> = new Set(EXPORT_COLUMNS);

function checkHeader(header: readonly string[]): Map<string, number> {
  const names = header.map((name) => pyStrip(name));
  const details: Array<readonly [string, string]> = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) details.push(['duplicate', echo(name)]);
    seen.add(name);
  }
  for (const column of COLUMNS) if (!seen.has(column)) details.push(['missing', column]);
  for (const name of names) if (!EXPORT_COLUMN_SET.has(name)) details.push(['unknown', echo(name)]);
  if (details.length > 0) {
    throw new CsvFileError(
      'csv_invalid_header',
      `The header must be exactly: ${COLUMNS.join(',')} (optionally ,updated_at)`,
      details,
    );
  }
  const positions = new Map<string, number>();
  names.forEach((name, index) => positions.set(name, index));
  return positions;
}

// --- Python csv.reader (strict dialect) -----------------------------------------------------------

type ReaderState =
  | 'START_RECORD'
  | 'START_FIELD'
  | 'IN_FIELD'
  | 'IN_QUOTED_FIELD'
  | 'QUOTE_IN_QUOTED_FIELD'
  | 'EAT_CRNL';

const EOL = Symbol('EOL');

/** Lines as `io.StringIO(text, newline="")` yields them (endings kept; `\r`, `\n`, `\r\n`). */
function* lines(text: string): Generator<string> {
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '\n') {
      yield text.slice(start, index + 1);
      start = index + 1;
    } else if (ch === '\r') {
      const end = text[index + 1] === '\n' ? index + 2 : index + 1;
      yield text.slice(start, end);
      start = end;
      index = end - 1;
    }
  }
  if (start < text.length) yield text.slice(start);
}

class CsvReader {
  lineNum = 0;
  private state: ReaderState = 'START_RECORD';
  private fields: string[] = [];
  private field: string[] = [];
  private fieldLen = 0;
  private readonly source: Generator<string>;

  constructor(text: string) {
    this.source = lines(text);
  }

  private fail(): never {
    throw new CsvFileError('csv_malformed', `Malformed CSV near line ${this.lineNum}`);
  }

  private saveField(): void {
    this.fields.push(this.field.join(''));
    this.field = [];
    this.fieldLen = 0;
  }

  private addChar(ch: string): void {
    if (this.fieldLen >= FIELD_SIZE_LIMIT) this.fail();
    this.field.push(ch);
    this.fieldLen += 1;
  }

  private process(c: string | typeof EOL): void {
    const isNewline = c === '\n' || c === '\r';
    switch (this.state) {
      case 'START_RECORD':
        if (c === EOL) return;
        if (isNewline) {
          this.state = 'EAT_CRNL';
          return;
        }
        this.state = 'START_FIELD';
        this.process(c);
        return;
      case 'START_FIELD':
        if (isNewline || c === EOL) {
          this.saveField();
          this.state = c === EOL ? 'START_RECORD' : 'EAT_CRNL';
        } else if (c === '"') {
          this.state = 'IN_QUOTED_FIELD';
        } else if (c === ',') {
          this.saveField();
        } else {
          this.addChar(c);
          this.state = 'IN_FIELD';
        }
        return;
      case 'IN_FIELD':
        if (isNewline || c === EOL) {
          this.saveField();
          this.state = c === EOL ? 'START_RECORD' : 'EAT_CRNL';
        } else if (c === ',') {
          this.saveField();
          this.state = 'START_FIELD';
        } else {
          this.addChar(c);
        }
        return;
      case 'IN_QUOTED_FIELD':
        if (c === EOL) return;
        if (c === '"') this.state = 'QUOTE_IN_QUOTED_FIELD';
        else this.addChar(c);
        return;
      case 'QUOTE_IN_QUOTED_FIELD':
        if (c === '"') {
          this.addChar(c);
          this.state = 'IN_QUOTED_FIELD';
        } else if (c === ',') {
          this.saveField();
          this.state = 'START_FIELD';
        } else if (isNewline || c === EOL) {
          this.saveField();
          this.state = c === EOL ? 'START_RECORD' : 'EAT_CRNL';
        } else {
          this.fail(); // strict: "',' expected after '"'"
        }
        return;
      case 'EAT_CRNL':
        if (isNewline) return;
        if (c === EOL) {
          this.state = 'START_RECORD';
          return;
        }
        this.fail();
    }
  }

  /** The next record, or `null` at the end of the input. */
  next(): string[] | null {
    this.fields = [];
    do {
      const step = this.source.next();
      if (step.done) {
        if (this.fieldLen !== 0 || this.state === 'IN_QUOTED_FIELD') this.fail();
        return null;
      }
      this.lineNum += 1;
      for (const ch of step.value) this.process(ch);
      this.process(EOL);
    } while (this.state !== 'START_RECORD');
    const record = this.fields;
    this.fields = [];
    return record;
  }
}

/**
 * Decode, check the header and validate every data row on its own. Throws `CsvFileError` for
 * file-level problems. Row problems are returned (all of them) and such rows are left out.
 */
export function parseCatalogCsv(raw: Uint8Array): ParsedCsv {
  const reader = new CsvReader(decodeCsv(raw));
  let header: string[] | null = null;
  for (let record = reader.next(); record !== null; record = reader.next()) {
    if (record.length > 0) {
      header = record;
      break;
    }
  }
  if (header === null) {
    throw new CsvFileError(
      'csv_invalid_header',
      `The file is empty; the header must be: ${EXPORT_COLUMNS.join(',')}`,
      COLUMNS.map((column) => ['missing', column] as const),
    );
  }
  const positions = checkHeader(header);
  const rows: CsvRow[] = [];
  const errors: CsvRowError[] = [];
  const seenSkus = new Set<string>();
  let total = 0;
  for (let record = reader.next(); record !== null; record = reader.next()) {
    if (record.length === 0 || (record.length === 1 && record[0] === '')) continue; // blank line
    total += 1;
    if (total > MAX_ROWS) {
      throw new CsvFileError('csv_too_many_rows', `At most ${MAX_ROWS} product rows per file`);
    }
    if (record.length !== positions.size) {
      throw new CsvFileError(
        'csv_malformed',
        `Row ${total} has ${record.length} fields, expected ${positions.size}`,
      );
    }
    const cells = new Map<string, string>();
    for (const [column, position] of positions) cells.set(column, record[position] ?? '');
    let [parsed, rowErrors] = parseRow(total, cells);
    const rawSku = pyStrip(cells.get('sku') ?? '');
    if (rawSku && seenSkus.has(rawSku)) {
      rowErrors = [
        ...rowErrors,
        { row: total, column: 'sku', code: 'duplicate_sku', message: 'SKU appears more than once' },
      ];
      parsed = null;
    }
    seenSkus.add(rawSku);
    errors.push(...rowErrors);
    if (parsed !== null) rows.push(parsed);
  }
  return { rows, errors, total_rows: total };
}

// --- cell parsers ---------------------------------------------------------------------------------

/** Un-escape one exported `'`, refuse formulas and unusable text, trim. */
function text(raw: string, multiline: boolean, maxLength: number): string {
  const escaped = raw.slice(0, 1) === "'" && EXPORT_ESCAPE_TRIGGERS.has(raw.slice(1, 2));
  if (!escaped && IMPORT_FORMULA_START.has(raw.slice(0, 1))) {
    throw new CellError(
      'formula_not_allowed',
      "Text must not start with = + @ or a tab/return (prefix it with ' to keep it)",
    );
  }
  let value = escaped ? raw.slice(1) : raw;
  if (multiline) value = value.replaceAll('\r\n', '\n');
  if ((multiline ? CONTROL_MULTILINE : CONTROL).test(value)) {
    throw new CellError('invalid_text', 'Contains control characters');
  }
  if (hasInvisibleCharacters(value, { multiline })) {
    throw new CellError(
      'invalid_text',
      'Contains invisible or text-direction characters (U+200B, U+202E...)',
    );
  }
  if (value.includes('\ufffd')) {
    throw new CellError('invalid_text', 'Contains U+FFFD (the file was not saved as UTF-8)');
  }
  if (MOJIBAKE.test(value)) {
    throw new CellError('invalid_text', 'Looks garbled (the file was not saved as UTF-8)');
  }
  value = pyStrip(value);
  if (pyLen(value) > maxLength)
    throw new CellError('invalid_text', `At most ${maxLength} characters`);
  // " =1" would become "=1" once trimmed. An escaped cell is text by the user's choice.
  if (!escaped && IMPORT_FORMULA_START.has(value.slice(0, 1))) {
    throw new CellError('formula_not_allowed', 'Text must not start with = + @');
  }
  return value;
}

function name(raw: string): string {
  const value = text(raw, false, MAX_NAME_LENGTH);
  if (!value) throw new CellError('required', 'Required');
  return value;
}

function description(raw: string): string | null {
  return text(raw, true, MAX_DESCRIPTION_LENGTH) || null;
}

function sku(raw: string): string {
  const value = pyStrip(raw);
  if (!value) throw new CellError('required', 'Required');
  if (!SKU_PATTERN.test(value)) {
    throw new CellError('invalid_sku', '1-64 of A-Z a-z 0-9 . _ - starting with a letter/digit');
  }
  return value;
}

function slug(raw: string, required = false): string | null {
  const value = pyStrip(raw);
  if (!value) {
    if (required) throw new CellError('required', 'Required');
    return null;
  }
  if (pyLen(value) > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(value)) {
    throw new CellError('invalid_slug', 'Lower-case words of a-z 0-9 joined by -');
  }
  return value;
}

function money(raw: string, required: boolean): number | null {
  const value = pyStrip(raw);
  if (!value) {
    if (required) throw new CellError('required', 'Required');
    return null;
  }
  if (!MONEY.test(value) || Number(value) > MAX_PRICE_UZS) {
    throw new CellError('invalid_money', 'Whole UZS: digits only, at most 10^12');
  }
  return Number(value);
}

function stock(raw: string): number | null {
  const value = pyStrip(raw);
  if (!value) return null;
  if (!STOCK.test(value) || Number(value) > MAX_STOCK) {
    throw new CellError('invalid_stock', `Empty (not tracked) or 0..${MAX_STOCK}`);
  }
  return Number(value);
}

function unit(raw: string): Unit {
  const value = pyStrip(raw);
  if (!value) throw new CellError('required', 'Required');
  const lowered = value.toLowerCase();
  if (!(UNITS as readonly string[]).includes(lowered)) {
    throw new CellError('invalid_unit', `One of: ${UNITS.join(', ')}`);
  }
  return lowered as Unit;
}

function bool(raw: string): boolean {
  const value = pyStrip(raw).toLowerCase();
  if (!value) throw new CellError('required', 'Required');
  if (TRUE.has(value)) return true;
  if (FALSE.has(value)) return false;
  throw new CellError('invalid_bool', 'true, false, 1 or 0');
}

function sortOrder(raw: string): number {
  const value = pyStrip(raw);
  if (!value) return 0;
  const number = Number(value);
  if (!SORT.test(value) || number < MIN_SORT_ORDER || number > MAX_SORT_ORDER) {
    throw new CellError('invalid_sort_order', `Whole number ${MIN_SORT_ORDER}..${MAX_SORT_ORDER}`);
  }
  return number;
}

function imageUrl(raw: string): string | null {
  const value = pyStrip(raw);
  if (!value) return null;
  try {
    return validateImageUrl(value);
  } catch (error) {
    if (error instanceof InvalidImageUrlError) {
      throw new CellError('invalid_image_url', `Image URL ${error.message}`);
    }
    throw error;
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const ISO_DATETIME =
  /^(\d{4})-?(\d{2})-?(\d{2})[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6}))?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:\.\d{1,6})?)?)?)?$/;

/**
 * Python `datetime.fromisoformat` (the forms an export or a spreadsheet produce), as epoch
 * microseconds; `null` when it is not a valid ISO datetime or has no time zone.
 */
export function parseAwareIsoMicros(value: string): bigint | null {
  const match = ISO_DATETIME.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi = '0', s = '0', fraction = '', zone] = match;
  if (zone === undefined) return null;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMicros = 0n;
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1n : 1n;
    const parts = /^[+-](\d{2}):?(\d{2})?:?(\d{2})?(?:\.(\d{1,6}))?$/.exec(zone);
    if (!parts) return null;
    const [, oh, om = '0', os = '0', of = ''] = parts;
    if (Number(oh) > 23 || Number(om) > 59 || Number(os) > 59) return null;
    offsetMicros =
      sign *
      ((BigInt(oh ?? '0') * 3600n + BigInt(om) * 60n + BigInt(os)) * 1_000_000n +
        BigInt(of.padEnd(6, '0') || '0'));
  }
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  const naive = BigInt(utcMillis) * 1000n + BigInt(fraction.padEnd(6, '0') || '0');
  return naive - offsetMicros;
}

function updatedAt(raw: string): bigint | null {
  const value = pyStrip(raw);
  if (!value) return null;
  const parsed = parseAwareIsoMicros(value);
  if (parsed === null) {
    throw new CellError(
      'invalid_updated_at',
      'Keep the exported value (ISO-8601 with time zone) or leave it empty',
    );
  }
  return parsed;
}

const PARSERS: ReadonlyArray<readonly [Column, (raw: string) => unknown]> = [
  ['sku', sku],
  ['slug', (raw) => slug(raw)],
  ['category_slug', (raw) => slug(raw, true)],
  ['name_uz', name],
  ['name_ru', name],
  ['description_uz', description],
  ['description_ru', description],
  ['unit', unit],
  ['price_uzs', (raw) => money(raw, true)],
  ['old_price_uzs', (raw) => money(raw, false)],
  ['stock_quantity', stock],
  ['is_active', bool],
  ['sort_order', sortOrder],
  ['image_url', imageUrl],
  ['updated_at', updatedAt],
];

function parseRow(row: number, cells: ReadonlyMap<string, string>): [CsvRow | null, CsvRowError[]] {
  const errors: CsvRowError[] = [];
  const values: Record<string, unknown> = {};
  for (const [column, parse] of PARSERS) {
    try {
      values[column] = parse(cells.get(column) ?? '');
    } catch (error) {
      if (!(error instanceof CellError)) throw error;
      errors.push({ row, column, code: error.code, message: error.message });
    }
  }
  if (errors.length > 0) return [null, errors];
  const price = values['price_uzs'] as number;
  const oldPrice = values['old_price_uzs'] as number | null;
  if (oldPrice !== null && oldPrice <= price) {
    return [
      null,
      [
        {
          row,
          column: 'old_price_uzs',
          code: 'invalid_old_price',
          message: 'Must be above price_uzs',
        },
      ],
    ];
  }
  return [
    {
      row,
      sku: values['sku'] as string,
      slug: values['slug'] as string | null,
      category_slug: values['category_slug'] as string,
      name_uz: values['name_uz'] as string,
      name_ru: values['name_ru'] as string,
      description_uz: values['description_uz'] as string | null,
      description_ru: values['description_ru'] as string | null,
      unit: values['unit'] as Unit,
      price_uzs: price,
      old_price_uzs: oldPrice,
      stock_quantity: values['stock_quantity'] as number | null,
      is_active: values['is_active'] as boolean,
      sort_order: values['sort_order'] as number,
      image_url: values['image_url'] as string | null,
      updated_at: values['updated_at'] as bigint | null,
    },
    [],
  ];
}

// --- planning against the current catalog ---------------------------------------------------------

/** Product fields an import sets (`slug` only when given or derived). */
export const PRODUCT_FIELDS = [
  'slug',
  'category_id',
  'name_uz',
  'name_ru',
  'description_uz',
  'description_ru',
  'unit',
  'price_uzs',
  'old_price_uzs',
  'stock_quantity',
  'is_active',
  'sort_order',
  'image_url',
] as const;
export type ProductField = (typeof PRODUCT_FIELDS)[number];
export type ProductValue = string | number | boolean | null;

export interface ExistingProduct {
  id: string;
  sku: string;
  archived: boolean;
  /** Current values of every field in `PRODUCT_FIELDS`. */
  values: Readonly<Record<string, ProductValue>>;
  /** The product's current `updated_at`, epoch microseconds. */
  updated_at: bigint;
}

export interface CatalogSnapshot {
  products_by_sku: ReadonlyMap<string, ExistingProduct>;
  /** Owner SKU of every slug the file uses (archived products included: slugs stay taken). */
  slug_owners: ReadonlyMap<string, string>;
  category_ids: ReadonlyMap<string, string>;
}

export type ChangeKind = 'create' | 'update' | 'unchanged';

export interface PlannedChange {
  kind: ChangeKind;
  row: number;
  sku: string;
  product_id: string | null;
  /** Target values for `PRODUCT_FIELDS` (create: all of them), in Python's insertion order. */
  values: Record<string, ProductValue>;
  /** `{field: [before, after]}`; for a create, `before` is `null`. */
  changes: Record<string, readonly [ProductValue, ProductValue]>;
}

export interface ImportPlan {
  changes: PlannedChange[];
  errors: CsvRowError[];
}

export function countKind(plan: ImportPlan, kind: ChangeKind): number {
  return plan.changes.filter((change) => change.kind === kind).length;
}

/** `DEMO_0001.a` -> `demo-0001-a`; `null` if nothing usable remains. */
export function deriveSlug(skuValue: string): string | null {
  const derived = skuValue
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return derived && SLUG_PATTERN.test(derived) ? derived : null;
}

/** Every product slug the file may assign (given or derived), for the snapshot query. */
export function referencedSlugs(rows: readonly CsvRow[]): Set<string> {
  const slugs = new Set<string>();
  for (const row of rows) {
    const candidate = row.slug || deriveSlug(row.sku);
    if (candidate !== null) slugs.add(candidate);
  }
  return slugs;
}

function staleRowError(row: CsvRow, existing: ExistingProduct | undefined): CsvRowError | null {
  if (row.updated_at === null) return null;
  if (existing === undefined) {
    return {
      row: row.row,
      column: 'updated_at',
      code: 'stale_row',
      message: 'No product has this SKU any more; export again (or clear updated_at to create it)',
    };
  }
  if (existing.updated_at !== row.updated_at) {
    return {
      row: row.row,
      column: 'updated_at',
      code: 'stale_row',
      message: 'The product changed after this file was exported; export again',
    };
  }
  return null;
}

/** Check the rows against the catalog and classify each SKU. Pure: writes nothing. */
export function planImport(rows: readonly CsvRow[], snapshot: CatalogSnapshot): ImportPlan {
  const errors: CsvRowError[] = [];
  const changes: PlannedChange[] = [];
  const claimed = new Map<string, string>(); // slug -> SKU claiming it within this file
  for (const row of rows) {
    const existing = snapshot.products_by_sku.get(row.sku);
    const rowErrors: CsvRowError[] = [];
    if (existing !== undefined && existing.archived) {
      rowErrors.push({
        row: row.row,
        column: 'sku',
        code: 'product_archived',
        message: 'Restore the product first',
      });
    }
    const stale = staleRowError(row, existing);
    if (stale !== null) rowErrors.push(stale);
    const categoryId = snapshot.category_ids.get(row.category_slug);
    if (categoryId === undefined) {
      rowErrors.push({
        row: row.row,
        column: 'category_slug',
        code: 'category_not_found',
        message: 'Unknown category',
      });
    }

    let slugValue = row.slug;
    if (slugValue === null && existing === undefined) {
      slugValue = deriveSlug(row.sku);
      if (slugValue === null) {
        rowErrors.push({
          row: row.row,
          column: 'slug',
          code: 'invalid_slug',
          message: 'Cannot derive a slug; set one',
        });
      }
    }
    if (slugValue !== null) {
      const owner = snapshot.slug_owners.get(slugValue);
      if (
        (owner !== undefined && owner !== row.sku) ||
        (claimed.get(slugValue) ?? row.sku) !== row.sku
      ) {
        rowErrors.push({
          row: row.row,
          column: 'slug',
          code: 'slug_taken',
          message: 'Slug is used by another product',
        });
      } else {
        claimed.set(slugValue, row.sku);
      }
    }
    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    const target: Record<string, ProductValue> = {
      category_id: categoryId ?? null,
      name_uz: row.name_uz,
      name_ru: row.name_ru,
      description_uz: row.description_uz,
      description_ru: row.description_ru,
      unit: row.unit,
      price_uzs: row.price_uzs,
      old_price_uzs: row.old_price_uzs,
      stock_quantity: row.stock_quantity,
      is_active: row.is_active,
      sort_order: row.sort_order,
      image_url: row.image_url,
    };
    if (slugValue !== null) target['slug'] = slugValue;
    if (existing === undefined) {
      const created: Record<string, readonly [ProductValue, ProductValue]> = {};
      for (const [field, value] of Object.entries(target)) created[field] = [null, value];
      changes.push({
        kind: 'create',
        row: row.row,
        sku: row.sku,
        product_id: null,
        values: target,
        changes: created,
      });
      continue;
    }
    const diff: Record<string, readonly [ProductValue, ProductValue]> = {};
    for (const [field, value] of Object.entries(target)) {
      const before = existing.values[field] ?? null;
      if (before !== value) diff[field] = [before, value];
    }
    changes.push({
      kind: Object.keys(diff).length > 0 ? 'update' : 'unchanged',
      row: row.row,
      sku: row.sku,
      product_id: existing.id,
      values: target,
      changes: diff,
    });
  }
  return { changes, errors };
}

/** Errors sorted by row (stable), at most `MAX_ERRORS`; and whether more were dropped. */
export function cappedErrors(errors: readonly CsvRowError[]): [CsvRowError[], boolean] {
  const ordered = [...errors].sort((a, b) => a.row - b.row);
  return [ordered.slice(0, MAX_ERRORS), ordered.length > MAX_ERRORS];
}

// --- export ---------------------------------------------------------------------------------------

export interface ExportRow {
  sku: string;
  slug: string;
  category_slug: string;
  name_uz: string;
  name_ru: string;
  description_uz: string | null;
  description_ru: string | null;
  unit: Unit;
  price_uzs: number;
  old_price_uzs: number | null;
  stock_quantity: number | null;
  is_active: boolean;
  sort_order: number;
  image_url: string | null;
  /** Already formatted: `2026-10-31T07:00:00.000000+00:00` (UTC, always microseconds). */
  updated_at: string;
}

/** Neutralise a text cell a spreadsheet would treat as a formula. */
export function escapeCell(value: string): string {
  return EXPORT_ESCAPE_TRIGGERS.has(value.slice(0, 1)) ? `'${value}` : value;
}

function cell(column: Column, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  // Enum values and the formatted timestamp are written as they are; other text is escaped.
  if (column === 'unit' || column === 'updated_at') return String(value);
  return escapeCell(String(value));
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** UTF-8 with BOM, CRLF, header first, every cell quoted. Text cells are formula-escaped. */
export function renderCsv(rows: Iterable<ExportRow>): Uint8Array {
  const out: string[] = [BOM, EXPORT_COLUMNS.map(quote).join(','), '\r\n'];
  for (const row of rows) {
    out.push(EXPORT_COLUMNS.map((column) => quote(cell(column, row[column]))).join(','), '\r\n');
  }
  return new TextEncoder().encode(out.join(''));
}

/** The header only (an example row would be imported if left in by mistake). */
export function renderTemplate(): Uint8Array {
  return renderCsv([]);
}
