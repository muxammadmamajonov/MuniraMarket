import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ErrorDetail } from '../../src/errors.ts';
import type { Validator } from '../../src/schemas/storefront/fields.ts';
import {
  addCartItemRequest,
  cancelOrderRequest,
  createOrderRequest,
  orderItemAdjustRequest,
  orderStatusUpdateRequest,
  savedAddressRequest,
  setCartItemQuantityRequest,
  updateProfileRequest,
} from '../../src/schemas/storefront/requests.ts';

/**
 * Request-body parity with the contract (audit T1). contract.test.ts proves the Function serves the
 * same operations; this proves the bodies agree too: for every storefront request model, the
 * fields the contract marks required are required here, and no field the contract documents is
 * refused as an extra input. A renamed or dropped field then fails here, not in production.
 */

interface ContractSchema {
  required?: string[];
  properties: Record<string, unknown>;
}

const contract = (
  JSON.parse(
    readFileSync(new URL('../../../../packages/contracts/openapi.json', import.meta.url), 'utf8'),
  ) as { components: { schemas: Record<string, ContractSchema> } }
).components.schemas;

const MODELS: Record<string, Validator<unknown>> = {
  AddCartItemRequest: addCartItemRequest,
  SetCartItemQuantityRequest: setCartItemQuantityRequest,
  CreateOrderRequest: createOrderRequest,
  CancelOrderRequest: cancelOrderRequest,
  OrderItemAdjustRequest: orderItemAdjustRequest,
  OrderStatusUpdateRequest: orderStatusUpdateRequest,
  UpdateProfileRequest: updateProfileRequest,
  SavedAddressRequest: savedAddressRequest,
};

function issuesFor(model: Validator<unknown>, body: unknown): ErrorDetail[] {
  const issues: ErrorDetail[] = [];
  model(body, ['body'], issues);
  return issues;
}

describe('request body parity with the contract', () => {
  for (const [name, model] of Object.entries(MODELS)) {
    describe(name, () => {
      const schema = contract[name];

      it('is in the contract', () => {
        expect(schema).toBeDefined();
      });

      it('requires exactly the fields the contract requires', () => {
        const required = issuesFor(model, {})
          .filter((i) => i.msg === 'Field required')
          .map((i) => i.loc[1])
          .sort();
        expect(required).toEqual([...(schema?.required ?? [])].sort());
      });

      it('accepts every documented field (none is refused as an extra input)', () => {
        const body = Object.fromEntries(
          Object.keys(schema?.properties ?? {}).map((k) => [k, null]),
        );
        const refused = issuesFor(model, body)
          .filter((i) => i.msg === 'Extra inputs are not permitted')
          .map((i) => i.loc[1]);
        expect(refused).toEqual([]);
      });

      it('still refuses an undocumented field', () => {
        const refused = issuesFor(model, { __undocumented__: 1 })
          .filter((i) => i.msg === 'Extra inputs are not permitted')
          .map((i) => i.loc[1]);
        expect(refused).toEqual(['__undocumented__']);
      });
    });
  }
});
