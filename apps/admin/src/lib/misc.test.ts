import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api/errors';
import { fieldErrorsFrom } from './api/field-errors';
import { writeErrorMessage } from './api/error-messages';
import { auditDetailLines } from './audit';
import { MAX_CSV_BYTES, csvFileProblem, formatBytes } from './csv';
import { formatCount, formatDate } from './format';
import { getDictionary } from '@/i18n';

describe('API errors', () => {
  it('keeps field details from the envelope', async () => {
    const error = await ApiRequestError.fromResponse(
      Response.json(
        {
          error: {
            code: 'validation_error',
            message: 'x',
            details: [
              { loc: ['body', 'price_uzs'], msg: 'bad' },
              { loc: ['body', 'items', 0], msg: 'bad' },
              { loc: ['query', 'page'], msg: 'bad' },
            ],
          },
        },
        { status: 422 },
      ),
    );
    expect(Object.keys(fieldErrorsFrom(error)).sort()).toEqual(['', 'items', 'price_uzs']);
  });

  it('puts a 422 without details on the form level', () => {
    const error = new ApiRequestError({ status: 422, code: 'validation_error', message: 'x' });
    expect(Object.keys(fieldErrorsFrom(error))).toEqual(['']);
  });

  it('translates write errors, every business code in both languages', () => {
    for (const locale of ['uz', 'ru'] as const) {
      const dict = getDictionary(locale);
      for (const code of Object.keys(dict.apiErrors.codes)) {
        const error = new ApiRequestError({ status: 409, code: code as never, message: 'x' });
        const text = writeErrorMessage(dict, error);
        expect(text).not.toBe('');
        expect(text).not.toContain('{');
      }
    }
    const dict = getDictionary('ru');
    expect(writeErrorMessage(dict, ApiRequestError.network())).toBe(dict.errors.serviceUnavailable);
    expect(
      writeErrorMessage(
        dict,
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

describe('formatting', () => {
  it('formats counts and dates', () => {
    expect(formatCount(1284)).toBe('1 284');
    expect(formatCount(-5)).toBe('-5');
    expect(formatDate('2026-10-31')).toBe('31.10.2026');
    expect(formatDate('garbage')).toBe('garbage');
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
