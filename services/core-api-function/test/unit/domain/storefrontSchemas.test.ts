import { describe, expect, it } from 'vitest';
import { escapeLike } from '../../../src/repositories/catalog.ts';
import { INVALID, model, pythonStrip } from '../../../src/schemas/storefront/fields.ts';
import {
  addCartItemRequest,
  createOrderRequest,
  requestHash,
  type CreateOrderRequest,
} from '../../../src/schemas/storefront/requests.ts';

function validate<T>(
  validator: (v: unknown, l: (string | number)[], i: { loc: string[]; msg: string }[]) => T,
  value: unknown,
) {
  const issues: { loc: string[]; msg: string }[] = [];
  const result = validator(value, ['body'], issues);
  return { result, issues };
}

describe('search escaping (port of test_search_escape.py)', () => {
  it('escapes LIKE wildcards', () => {
    expect(escapeLike('50%_off')).toBe('50\\%\\_off');
  });
  it('escapes the backslash first so escapes are not doubled', () => {
    expect(escapeLike('a\\%')).toBe('a\\\\\\%');
  });
});

describe('request models', () => {
  it('reports Pydantic-shaped errors in field order, extras per key', () => {
    const { result, issues } = validate(addCartItemRequest, { quantity: 100, extra: 1 });
    expect(result).toBe(INVALID);
    expect(issues).toEqual([
      { loc: ['body', 'product_id'], msg: 'Field required' },
      { loc: ['body', 'quantity'], msg: 'Input should be less than or equal to 99' },
      { loc: ['body', 'extra'], msg: 'Extra inputs are not permitted' },
    ]);
    expect(validate(model({}), []).issues[0]?.msg).toBe(
      'Input should be a valid dictionary or object to extract fields from',
    );
  });

  it('accepts lax integers and canonicalises UUIDs', () => {
    const { result } = validate(addCartItemRequest, {
      product_id: '6F1C1B8E111141118111111111111111',
      quantity: '5',
    });
    expect(result).toEqual({ product_id: '6f1c1b8e-1111-4111-8111-111111111111', quantity: 5 });
  });

  it('strips with Python whitespace rules', () => {
    expect(pythonStrip('\u001f a \u0085')).toBe('a');
    expect(pythonStrip('﻿a')).toBe('﻿a');
  });

  it('never echoes submitted values', () => {
    const { issues } = validate(createOrderRequest, {
      address: { district: 'tashkent', street: 'Demo\nko‘cha', house: '1' },
      recipient_name: 'Demo Mijoz',
      recipient_phone: '998001234567',
      payment_method: 'cash_on_delivery',
      expected_total_uzs: -1,
    });
    expect(issues.map((issue) => issue.loc.join('.'))).toEqual([
      'body.address.district',
      'body.address.street',
      'body.recipient_phone',
      'body.expected_total_uzs',
    ]);
    const text = JSON.stringify(issues);
    expect(text).not.toContain('998001234567');
    expect(text).not.toContain('Demo');
  });

  // Hashes computed by the FastAPI reference (`request_hash(CreateOrderRequest(...))`).
  it('hashes requests byte-identically to the reference', () => {
    const vectors: [unknown, string][] = [
      [
        {
          address: { district: 'chilonzor', street: ' Demo ko‘cha  ', house: '12 ', floor: '' },
          recipient_name: ' Демо Мижоз ',
          recipient_phone: '+998 00 123-45-67',
          payment_method: 'cash_on_delivery',
          comment: "Eshik\tqo'ng'irog'i\nishlamaydi ",
          expected_total_uzs: 65000.0,
        },
        '678116f4db89c51e02b015863eb631bd6f6f92e1af4e3481a011932e942ed82e',
      ],
      [
        {
          address: {
            district: 'yunusobod',
            street: 'Demo',
            house: '1',
            apartment: '5',
            entrance: '2',
            floor: '3',
            landmark: '"Bozor" / yoni',
          },
          recipient_name: 'Demo Mijoz',
          recipient_phone: '+998001234567',
          payment_method: 'card_on_delivery',
          expected_total_uzs: '95_000',
          delivery_slot_id: '6F1C1B8E111141118111111111111111',
        },
        '2e919cbe2d3006bdb380b97df4dbe598b519c362698a95e3315010d683a1d677',
      ],
    ];
    for (const [body, expected] of vectors) {
      const { result, issues } = validate(createOrderRequest, body);
      expect(issues).toEqual([]);
      expect(requestHash(result as CreateOrderRequest)).toBe(expected);
    }
  });
});
