import { describe, expect, it } from 'vitest';
import { address, textOfLength, WORST } from './test-fixtures';
import {
  PHONE_PREFIX,
  buildOrderRequest,
  charCount,
  clampChars,
  emptyFormValues,
  firstInvalidField,
  normalizePhone,
  requestFingerprint,
  serverFieldErrors,
  validateForm,
  type CheckoutFormValues,
} from './form';

function valid(overrides: Partial<CheckoutFormValues> = {}): CheckoutFormValues {
  return {
    ...emptyFormValues(),
    address: address({ apartment: '' }),
    recipientName: 'Ali Valiyev',
    recipientPhone: '+998 00 123-45-67',
    paymentMethod: 'cash_on_delivery',
    ...overrides,
  };
}

describe('normalizePhone', () => {
  it.each([
    ['+998001234567', '+998001234567'],
    ['+998 00 123 45 67', '+998001234567'],
    ['+998 (00) 123-45-67', '+998001234567'],
    ['  +998-00-123-45-67 ', '+998001234567'],
  ])('accepts %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each([
    '',
    '+998',
    '998001234567',
    '+99800123456',
    '+9980012345678',
    '+7 900 123 45 67',
    '+998 00 123 45 6a',
    '+998.90.123.45.67',
  ])('rejects %j', (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });
});

describe('validateForm', () => {
  it('starts with nothing selected and a +998 prefix in the phone field', () => {
    const empty = emptyFormValues();
    expect(empty.address).toBeNull();
    expect(empty.paymentMethod).toBe('');
    expect(empty.recipientPhone).toBe(PHONE_PREFIX);
  });

  it('flags every required field of an empty form, in page order', () => {
    const errors = validateForm(emptyFormValues());
    expect(Object.keys(errors).sort()).toEqual(
      ['address', 'paymentMethod', 'recipientName', 'recipientPhone'].sort(),
    );
    expect(errors.address).toEqual({ kind: 'required' });
    expect(errors.recipientPhone).toEqual({ kind: 'required' });
    expect(firstInvalidField(errors)).toBe('address');
  });

  it('accepts a complete form, with optional fields empty', () => {
    expect(validateForm(valid())).toEqual({});
  });

  it('flags an address that is incomplete or has no valid point as invalid (one field)', () => {
    expect(validateForm(valid({ address: address({ house: '' }) })).address).toEqual({
      kind: 'invalid',
    });
    expect(validateForm(valid({ address: address({ street: 'x'.repeat(201) }) })).address).toEqual({
      kind: 'invalid',
    });
    expect(validateForm(valid({ address: address({ lat: Number.NaN }) })).address).toEqual({
      kind: 'invalid',
    });
    expect(validateForm(valid({ address: address({ lon: 181 }) })).address).toEqual({
      kind: 'invalid',
    });
    expect(validateForm(valid({ address: address({ lat: 90, lon: -180 }) })).address).toBe(
      undefined,
    );
  });

  it('mirrors the server limits at their exact edges', () => {
    expect(validateForm(valid({ recipientName: 'x' })).recipientName?.kind).toBe('tooShort');
    expect(validateForm(valid({ recipientName: 'x'.repeat(100) })).recipientName).toBeUndefined();
    expect(validateForm(valid({ recipientName: 'x'.repeat(101) })).recipientName?.kind).toBe(
      'tooLong',
    );
    expect(validateForm(valid({ comment: 'x'.repeat(500) })).comment).toBeUndefined();
    expect(validateForm(valid({ comment: 'x'.repeat(501) })).comment?.kind).toBe('tooLong');
  });

  it('measures length in characters like the server (code points, after trimming)', () => {
    // 100 emoji are 200 UTF-16 units but 100 characters: allowed.
    expect(validateForm(valid({ recipientName: '😀'.repeat(100) })).recipientName).toBeUndefined();
    expect(validateForm(valid({ recipientName: '😀'.repeat(101) })).recipientName?.kind).toBe(
      'tooLong',
    );
    expect(validateForm(valid({ recipientName: '  ab  ' })).recipientName).toBeUndefined();
    expect(validateForm(valid({ recipientName: '   ' })).recipientName).toEqual({
      kind: 'required',
    });
    expect(charCount('a😀b')).toBe(3);
    expect(clampChars('a😀b', 2)).toBe('a😀');
  });

  it('accepts the realistic worst-case values at their limits', () => {
    const errors = validateForm(
      valid({
        address: address({ street: WORST.street, landmark: WORST.landmark }),
        recipientName: WORST.recipientName,
        comment: WORST.comment,
      }),
    );
    expect(errors).toEqual({});
  });

  it('rejects a phone that is not +998 and nine digits, with the phone message', () => {
    expect(validateForm(valid({ recipientPhone: '+998 00 123' })).recipientPhone).toEqual({
      kind: 'phone',
    });
    expect(validateForm(valid({ recipientPhone: '+998 ' })).recipientPhone).toEqual({
      kind: 'required',
    });
  });

  it('rejects line breaks in single-line fields but allows them in the comment', () => {
    expect(validateForm(valid({ recipientName: 'a\nb' })).recipientName).toEqual({
      kind: 'singleLine',
    });
    expect(validateForm(valid({ comment: 'line 1\nline 2' })).comment).toBeUndefined();
    expect(validateForm(valid({ comment: 'bell\u0007' })).comment).toEqual({ kind: 'invalid' });
  });
});

describe('buildOrderRequest', () => {
  it('builds the API body: normalized phone, trimmed text, blank optionals omitted', () => {
    const request = buildOrderRequest(
      valid({
        address: address({
          lat: 41.31108149,
          lon: 69.24056251,
          street: '  Demo ko‘cha  ',
          apartment: '  ',
          landmark: ' Metro ',
        }),
        recipientName: '  Ali Valiyev ',
        comment: '',
      }),
      60000,
    );
    expect(request).toEqual({
      address: {
        lat: 41.311081,
        lon: 69.240563,
        street: 'Demo ko‘cha',
        house: '12',
        landmark: 'Metro',
      },
      recipient_name: 'Ali Valiyev',
      recipient_phone: '+998001234567',
      payment_method: 'cash_on_delivery',
      expected_total_uzs: 60000,
    });
    // Exactly these keys, in this order (the idempotency fingerprint): nothing else is sent.
    expect(Object.keys(request?.address ?? {})).toEqual([
      'lat',
      'lon',
      'street',
      'house',
      'landmark',
    ]);
    expect(Object.keys(request ?? {})).toEqual([
      'address',
      'recipient_name',
      'recipient_phone',
      'payment_method',
      'expected_total_uzs',
    ]);
  });

  it('is null while the form is invalid', () => {
    expect(buildOrderRequest(emptyFormValues(), 1)).toBeNull();
    expect(buildOrderRequest(valid({ recipientPhone: '123' }), 1)).toBeNull();
    expect(buildOrderRequest(valid({ address: null }), 1)).toBeNull();
    expect(buildOrderRequest(valid({ address: address({ house: ' ' }) }), 1)).toBeNull();
  });

  it('includes every optional field when given', () => {
    const request = buildOrderRequest(
      valid({
        address: address({ apartment: '5', entrance: '2', floor: '3', landmark: 'Pharmacy' }),
        comment: 'Ring',
      }),
      1000,
    );
    expect(request?.address).toEqual({
      lat: 41.311081,
      lon: 69.240562,
      street: 'Demo ko‘cha',
      house: '12',
      apartment: '5',
      entrance: '2',
      floor: '3',
      landmark: 'Pharmacy',
    });
    expect(request?.comment).toBe('Ring');
  });
});

describe('requestFingerprint', () => {
  it('is equal for identical forms and different when anything, including the total, changes', () => {
    const a = buildOrderRequest(valid(), 60000);
    const sameButSpacedPhone = buildOrderRequest(valid({ recipientPhone: '+998001234567' }), 60000);
    const otherTotal = buildOrderRequest(valid(), 80000);
    const otherStreet = buildOrderRequest(
      valid({ address: address({ street: 'Boshqa ko‘cha' }) }),
      60000,
    );
    const otherPin = buildOrderRequest(valid({ address: address({ lat: 41.311082 }) }), 60000);
    // Below the 6-decimal rounding: the same point, so the same order.
    const samePin = buildOrderRequest(
      valid({ address: address({ apartment: '', lat: 41.3110811 }) }),
      60000,
    );
    if (
      a === null ||
      sameButSpacedPhone === null ||
      otherTotal === null ||
      otherStreet === null ||
      otherPin === null ||
      samePin === null
    ) {
      throw new Error('fixtures must be valid');
    }
    expect(requestFingerprint(a)).toBe(requestFingerprint(sameButSpacedPhone));
    expect(requestFingerprint(a)).toBe(requestFingerprint(samePin));
    expect(requestFingerprint(a)).not.toBe(requestFingerprint(otherTotal));
    expect(requestFingerprint(a)).not.toBe(requestFingerprint(otherStreet));
    expect(requestFingerprint(a)).not.toBe(requestFingerprint(otherPin));
  });
});

describe('serverFieldErrors', () => {
  it('maps 422 locations onto form fields, however deep the loc is', () => {
    const { fields, unmapped } = serverFieldErrors([
      { loc: ['body', 'recipient_phone'], msg: 'phone must be …' },
      { loc: ['body', 'address', 'street'], msg: 'too short' },
      { loc: ['body', 'address', 'lon'], msg: 'bad' },
      { loc: ['body', 'comment'], msg: 'control characters' },
    ]);
    expect(Object.keys(fields).sort()).toEqual(['address', 'comment', 'recipientPhone']);
    expect(fields.address).toEqual({ kind: 'invalid' });
    expect(fields.recipientPhone).toEqual({ kind: 'invalid' });
    expect(unmapped).toBe(0);
  });

  it('counts details that have no field on the form', () => {
    const { fields, unmapped } = serverFieldErrors([
      { loc: ['body', 'expected_total_uzs'], msg: 'ge 0' },
      { loc: ['header', 'Idempotency-Key'], msg: 'pattern' },
    ]);
    expect(fields).toEqual({});
    expect(unmapped).toBe(2);
  });
});

describe('textOfLength', () => {
  it('builds exact lengths', () => {
    expect(textOfLength('abc', 8)).toBe('abcabcab');
    expect(WORST.productNameUz.length).toBeLessThanOrEqual(255);
    expect(WORST.street).toHaveLength(200);
    expect(charCount(WORST.recipientName)).toBeLessThanOrEqual(100);
  });
});
