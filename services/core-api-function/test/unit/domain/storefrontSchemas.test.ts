import { describe, expect, it } from 'vitest';
import { escapeLike } from '../../../src/repositories/catalog.ts';
import { INVALID, model, pythonStrip } from '../../../src/schemas/storefront/fields.ts';
import {
  addCartItemRequest,
  createOrderRequest,
  deliveryAddress,
  pydanticFloat,
  requestHash,
  type CreateOrderRequest,
} from '../../../src/schemas/storefront/requests.ts';

const text = (value: unknown): string => JSON.stringify(value);

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
      address: { lat: 141.5, lon: 69.2, street: 'Demo\nko‘cha', house: '1' },
      recipient_name: 'Demo Mijoz',
      recipient_phone: '998001234567',
      payment_method: 'cash_on_delivery',
      expected_total_uzs: -1,
    });
    expect(issues.map((issue) => issue.loc.join('.'))).toEqual([
      'body.address.lat',
      'body.address.street',
      'body.recipient_phone',
      'body.expected_total_uzs',
    ]);
    expect(text(issues)).not.toContain('141.5');
    expect(text(issues)).not.toContain('998001234567');
    expect(text(issues)).not.toContain('Demo');
  });

  it('validates coordinates like Pydantic (lax, finite, WGS84 range) and rounds them', () => {
    const address = (lat: unknown, lon: unknown) =>
      validate(deliveryAddress, { lat, lon, street: 'Demo', house: '1' });
    expect(address(41.31108149, '69.2405626').result).toMatchObject({
      lat: 41.311081,
      lon: 69.240563,
    });
    expect(address(' 41.3 ', '1_0').result).toMatchObject({ lat: 41.3, lon: 10 });
    expect(address(90, -180).result).toMatchObject({ lat: 90, lon: -180 });
    const messages = (lat: unknown, lon: unknown) => address(lat, lon).issues.map((i) => i.msg);
    expect(messages(90.5, 0)).toEqual(['Input should be less than or equal to 90']);
    expect(messages(-90.5, 0)).toEqual(['Input should be greater than or equal to -90']);
    expect(messages(0, 180.000001)).toEqual(['Input should be less than or equal to 180']);
    expect(messages(0, '-1e3')).toEqual(['Input should be greater than or equal to -180']);
    expect(messages('nan', 'inf')).toEqual([
      'Input should be a finite number',
      'Input should be a finite number',
    ]);
    expect(messages('x', '')).toEqual([
      'Input should be a valid number, unable to parse string as a number',
      'Input should be a valid number, unable to parse string as a number',
    ]);
    expect(messages(null, [])).toEqual([
      'Input should be a valid number',
      'Input should be a valid number',
    ]);
    expect(messages(undefined, 1)).toEqual(['Field required']);
  });

  it('refuses unknown address fields', () => {
    const { result, issues } = validate(deliveryAddress, {
      lat: 41.3,
      lon: 69.2,
      area: 'old-client',
      street: 'Demo',
      house: '1',
    });
    expect(result).toBe(INVALID);
    expect(issues).toEqual([{ loc: ['body', 'area'], msg: 'Extra inputs are not permitted' }]);
  });

  it('formats floats like Pydantic JSON', () => {
    expect([69, -0, 41.311081, 1e-5, 4e-6, -1.5e-6, 1e-7, -179.999999].map(pydanticFloat)).toEqual([
      '69.0',
      '-0.0',
      '41.311081',
      '0.00001',
      '4e-6',
      '-1.5e-6',
      '1e-7',
      '-179.999999',
    ]);
  });

  // Hashes computed by the FastAPI reference (`request_hash(CreateOrderRequest(...))`).
  it('hashes requests byte-identically to the reference', () => {
    const vectors: [unknown, string][] = [
      [
        {
          address: {
            lat: 41.31108149,
            lon: '69.240562',
            street: ' Demo ko‘cha  ',
            house: '12 ',
            floor: '',
          },
          recipient_name: ' Демо Мижоз ',
          recipient_phone: '+998 00 123-45-67',
          payment_method: 'cash_on_delivery',
          comment: "Eshik\tqo'ng'irog'i\nishlamaydi ",
          expected_total_uzs: 65000.0,
        },
        'dd15243f299dda023a73098d3e431042bd2472cd3074ae9d434e411f50cd8204',
      ],
      [
        {
          address: {
            lat: 41,
            lon: 69.2,
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
        },
        '7c117136a721b0865f5df86faaca8e939e2a418973e8bae24ca079e7fab8df63',
      ],
      [
        {
          address: { lat: -0.000004, lon: 0.00001, street: 'Demo', house: '1' },
          recipient_name: 'Demo Mijoz',
          recipient_phone: '+998001234567',
          payment_method: 'card_on_delivery',
          expected_total_uzs: 1,
        },
        '28ad7262df74491e0d686e7d172bd8a8e39985db5f2450baf130fb3a48a6181c',
      ],
    ];
    for (const [body, expected] of vectors) {
      const { result, issues } = validate(createOrderRequest, body);
      expect(issues).toEqual([]);
      expect(requestHash(result as CreateOrderRequest)).toBe(expected);
    }
  });
});
