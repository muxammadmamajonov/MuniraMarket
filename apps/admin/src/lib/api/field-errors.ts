import type { ApiRequestError } from './errors';

/**
 * Field-level problems of a 422 `validation_error`, keyed by request field name. The API's `loc`
 * looks like `["body", "price_uzs"]` (or `["body", "districts", 0]` for a list item); the field is
 * the first segment after `body`. Anything that cannot be tied to a field (`["body"]`, a query
 * parameter) is returned under `''` so the form can show it as a general error.
 */
export type FieldErrors = Record<string, true>;

export const FORM_LEVEL = '';

export function fieldErrorsFrom(error: ApiRequestError): FieldErrors {
  const fields: FieldErrors = {};
  if (error.code !== 'validation_error' && error.status !== 422) return fields;
  if (error.details.length === 0) {
    fields[FORM_LEVEL] = true;
    return fields;
  }
  for (const detail of error.details) {
    const [origin, name] = detail.loc;
    fields[origin === 'body' && typeof name === 'string' ? name : FORM_LEVEL] = true;
  }
  return fields;
}
