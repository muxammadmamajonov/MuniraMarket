import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api/errors';
import { fieldErrorsFrom } from './api/field-errors';
import { writeErrorMessage } from './api/error-messages';
import { auditDetailLines } from './audit';
import { MAX_CSV_BYTES, csvFileProblem, formatBytes } from './csv';
import { DISTRICT_CODES, districtName } from './districts';
import { formatCount, formatDate, formatSlotWindow } from './format';
import { buildZoneUpdate, validateZone, zoneToForm } from './zones';
import { zone } from '@/test-utils/fixtures';
import { getDictionary } from '@/i18n';

describe('API errors', () => {
  it('keeps field details and the district from the envelope', async () => {
    const error = await ApiRequestError.fromResponse(
      Response.json(
        {
          error: {
            code: 'validation_error',
            message: 'x',
            details: [
              { loc: ['body', 'price_uzs'], msg: 'bad' },
              { loc: ['body', 'districts', 0], msg: 'bad' },
              { loc: ['query', 'page'], msg: 'bad' },
            ],
          },
        },
        { status: 422 },
      ),
    );
    expect(Object.keys(fieldErrorsFrom(error)).sort()).toEqual(['', 'districts', 'price_uzs']);
    const taken = await ApiRequestError.fromResponse(
      Response.json(
        { error: { code: 'district_taken', message: 'x', district: 'sergeli' } },
        { status: 409 },
      ),
    );
    expect(taken.district).toBe('sergeli');
  });

  it('puts a 422 without details on the form level', () => {
    const error = new ApiRequestError({ status: 422, code: 'validation_error', message: 'x' });
    expect(Object.keys(fieldErrorsFrom(error))).toEqual(['']);
  });

  it('translates write errors, every business code in both languages', () => {
    for (const locale of ['uz', 'ru'] as const) {
      const dict = getDictionary(locale);
      for (const code of Object.keys(dict.apiErrors.codes)) {
        const error = new ApiRequestError({
          status: 409,
          code: code as never,
          message: 'x',
          district: 'mirobod',
        });
        const text = writeErrorMessage(dict, locale, error);
        expect(text).not.toBe('');
        expect(text).not.toContain('{');
      }
    }
    const dict = getDictionary('ru');
    expect(writeErrorMessage(dict, 'ru', ApiRequestError.network())).toBe(
      dict.errors.serviceUnavailable,
    );
    expect(
      writeErrorMessage(
        dict,
        'ru',
        new ApiRequestError({ status: 409, code: 'bad_request', message: 'x' }),
      ),
    ).toBe(dict.apiErrors.writeFailed);
  });
});

describe('csv helpers', () => {
  it('checks extension, emptiness and the 1 MiB limit', () => {
    expect(csvFileProblem({ name: 'a.CSV', size: 10 })).toBeNull();
    expect(csvFileProblem({ name: 'a.xlsx', size: 10 })).toBe('not_csv');
    expect(csvFileProblem({ name: 'a.csv', size: 0 })).toBe('empty');
    expect(csvFileProblem({ name: 'a.csv', size: MAX_CSV_BYTES })).toBeNull();
    expect(csvFileProblem({ name: 'a.csv', size: MAX_CSV_BYTES + 1 })).toBe('too_large');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});

describe('formatting and districts', () => {
  it('formats counts, dates and slot windows', () => {
    expect(formatCount(1284)).toBe('1 284');
    expect(formatCount(-5)).toBe('-5');
    expect(formatDate('2026-10-31')).toBe('31.10.2026');
    expect(formatDate('garbage')).toBe('garbage');
    expect(formatSlotWindow('2026-11-02', '14:00:00', '16:00')).toBe('02.11.2026, 14:00–16:00');
  });

  it('names all twelve districts in both languages', () => {
    expect(DISTRICT_CODES).toHaveLength(12);
    expect(districtName('chilonzor', 'ru')).toBe('Чиланзарский');
    expect(districtName('mirzo_ulugbek', 'uz')).toBe('Mirzo Ulug‘bek');
    expect(districtName('unknown', 'uz')).toBe('unknown');
  });
});

describe('audit details', () => {
  it('flattens changes and scalar context, skipping nested values', () => {
    expect(
      auditDetailLines({
        changes: { role: { from: 'customer', to: 'admin' } },
        rows: 3,
        nested: { a: 1 },
      }),
    ).toEqual([
      { key: 'role', from: 'customer', to: 'admin', change: true },
      { key: 'rows', to: 3, change: false },
    ]);
    expect(auditDetailLines({})).toEqual([]);
    expect(auditDetailLines({ changes: 'oops' })).toEqual([]);
  });
});

describe('zone form', () => {
  it('validates hours, districts and money, and diffs districts regardless of order', () => {
    const values = zoneToForm(zone());
    expect(validateZone(values)).toEqual({});
    expect(validateZone({ ...values, districts: [] })).toHaveProperty('districts');
    expect(validateZone({ ...values, opens_at: '21:00', closes_at: '09:00' })).toHaveProperty(
      'closes_at',
    );
    expect(validateZone({ ...values, fee: '' })).toHaveProperty('delivery_fee_uzs');
    expect(validateZone({ ...values, free_threshold: '' })).toEqual({});
    expect(buildZoneUpdate(values, zone())).toEqual({});
    expect(buildZoneUpdate({ ...values, free_threshold: '' }, zone())).toEqual({
      free_delivery_threshold_uzs: null,
    });
  });
});
