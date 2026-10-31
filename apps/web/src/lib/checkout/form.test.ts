import { describe, expect, it } from 'vitest';
import { textOfLength, WORST } from './test-fixtures';
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
    district: 'yunusobod',
    street: 'Demo ko‘cha',
    house: '12',
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
    expect(empty.district).toBe('');
    expect(empty.paymentMethod).toBe('');
    expect(empty.recipientPhone).toBe(PHONE_PREFIX);
  });

  it('flags every required field of an empty form, in page order', () => {
    const errors = validateForm(emptyFormValues());
    expect(Object.keys(errors).sort()).toEqual(
      ['district', 'house', 'paymentMethod', 'recipientName', 'recipientPhone', 'street'].sort(),
    );
    expect(errors.recipientPhone).toEqual({ kind: 'required' });
    expect(firstInvalidField(errors)).toBe('district');
  });

  it('accepts a complete form, with optional fields empty', () => {
    expect(validateForm(valid())).toEqual({});
  });

  it('mirrors the server limits at their exact edges', () => {
    expect(validateForm(valid({ street: 'ab' })).street).toBeUndefined();
    expect(validateForm(valid({ street: 'a' })).street).toEqual({ kind: 'tooShort', limit: 2 });
    expect(validateForm(valid({ street: 'x'.repeat(200) })).street).toBeUndefined();
    expect(validateForm(valid({ street: 'x'.repeat(201) })).street).toEqual({
      kind: 'tooLong',
      limit: 200,
    });
    expect(validateForm(valid({ house: 'x'.repeat(32) })).house).toBeUndefined();
    expect(validateForm(valid({ house: 'x'.repeat(33) })).house?.kind).toBe('tooLong');
    expect(validateForm(valid({ apartment: 'x'.repeat(17) })).apartment?.kind).toBe('tooLong');
    expect(validateForm(valid({ entrance: 'x'.repeat(17) })).entrance?.kind).toBe('tooLong');
    expect(validateForm(valid({ floor: 'x'.repeat(9) })).floor?.kind).toBe('tooLong');
    expect(validateForm(valid({ landmark: 'x'.repeat(201) })).landmark?.kind).toBe('tooLong');
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
    expect(validateForm(valid({ street: '  ab  ' })).street).toBeUndefined();
    expect(validateForm(valid({ street: '   ' })).street).toEqual({ kind: 'required' });
    expect(charCount('a😀b')).toBe(3);
    expect(clampChars('a😀b', 2)).toBe('a😀');
  });

  it('accepts the realistic worst-case values at their limits', () => {
    const errors = validateForm(
      valid({
        street: WORST.street,
        landmark: WORST.landmark,
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
    expect(validateForm(valid({ street: 'a\nb' })).street).toEqual({ kind: 'singleLine' });
    expect(validateForm(valid({ comment: 'line 1\nline 2' })).comment).toBeUndefined();
    expect(validateForm(valid({ comment: 'bell\u0007' })).comment).toEqual({ kind: 'invalid' });
  });
});

describe('buildOrderRequest', () => {
  it('builds the API body: normalized phone, trimmed text, blank optionals omitted', () => {
    const request = buildOrderRequest(
      valid({ street: '  Demo ko‘cha  ', apartment: '  ', landmark: ' Metro ', comment: '' }),
      75000,
    );
    expect(request).toEqual({
      address: { district: 'yunusobod', street: 'Demo ko‘cha', house: '12', landmark: 'Metro' },
      recipient_name: 'Ali Valiyev',
      recipient_phone: '+998001234567',
      payment_method: 'cash_on_delivery',
      expected_total_uzs: 75000,
    });
    expect(request?.address).not.toHaveProperty('apartment');
    expect(request).not.toHaveProperty('comment');
  });

  it('is null while the form is invalid', () => {
    expect(buildOrderRequest(emptyFormValues(), 1)).toBeNull();
    expect(buildOrderRequest(valid({ recipientPhone: '123' }), 1)).toBeNull();
  });

  it('includes every optional field when given', () => {
    const request = buildOrderRequest(
      valid({ apartment: '5', entrance: '2', floor: '3', landmark: 'Pharmacy', comment: 'Ring' }),
      1000,
    );
    expect(request?.address).toEqual({
      district: 'yunusobod',
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
    const a = buildOrderRequest(valid(), 75000);
    const sameButSpacedPhone = buildOrderRequest(valid({ recipientPhone: '+998001234567' }), 75000);
    const otherTotal = buildOrderRequest(valid(), 80000);
    const otherStreet = buildOrderRequest(valid({ street: 'Boshqa ko‘cha' }), 75000);
    if (a === null || sameButSpacedPhone === null || otherTotal === null || otherStreet === null) {
      throw new Error('fixtures must be valid');
    }
    expect(requestFingerprint(a)).toBe(requestFingerprint(sameButSpacedPhone));
    expect(requestFingerprint(a)).not.toBe(requestFingerprint(otherTotal));
    expect(requestFingerprint(a)).not.toBe(requestFingerprint(otherStreet));
  });
});

describe('serverFieldErrors', () => {
  it('maps 422 locations onto form fields, however deep the loc is', () => {
    const { fields, unmapped } = serverFieldErrors([
      { loc: ['body', 'recipient_phone'], msg: 'phone must be …' },
      { loc: ['body', 'address', 'street'], msg: 'too short' },
      { loc: ['body', 'address', 'district'], msg: 'bad' },
      { loc: ['body', 'comment'], msg: 'control characters' },
    ]);
    expect(Object.keys(fields).sort()).toEqual(['comment', 'district', 'recipientPhone', 'street']);
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

describe('buildOrderRequest: delivery slot', () => {
  it('leaves delivery_slot_id out when no slot is chosen', () => {
    const request = buildOrderRequest(valid(), 75000);
    expect(request).not.toBeNull();
    expect(request).not.toHaveProperty('delivery_slot_id');
    expect(buildOrderRequest(valid(), 75000, null)).toEqual(request);
  });

  it('sends the chosen slot, and a different slot is a different fingerprint', () => {
    const a = buildOrderRequest(valid(), 75000, 'slot-a');
    const b = buildOrderRequest(valid(), 75000, 'slot-b');
    const none = buildOrderRequest(valid(), 75000);
    if (a === null || b === null || none === null) throw new Error('form should be valid');
    expect(a.delivery_slot_id).toBe('slot-a');
    expect(requestFingerprint(a)).not.toBe(requestFingerprint(b));
    expect(requestFingerprint(a)).not.toBe(requestFingerprint(none));
    // Same input, same fingerprint: that is what lets a retry reuse its key.
    expect(requestFingerprint(a)).toBe(
      requestFingerprint(buildOrderRequest(valid(), 75000, 'slot-a') ?? a),
    );
  });
});
