/**
 * Whether the legal pages' wording has been written, approved and loaded.
 *
 * - `'pending'`: no approved legal text exists. No public route may show legal content, and the
 *   launch gate treats this as a blocker for going live.
 * - `'approved'`: content for every page in `LEGAL_PAGES` has passed `validateLegalContent`, and
 *   its `approvedBy` role has signed off.
 *
 * It is declared with the wide type on purpose: a comparison such as
 * `LEGAL_CONTENT_STATUS === 'approved'` must stay legal for the gate to write, and flipping the
 * value to `'approved'` is a one-line change made together with the content, never before.
 */
export type LegalContentStatus = 'pending' | 'approved';

export const LEGAL_CONTENT_STATUS: LegalContentStatus = 'pending';

/** True when the launch gate may let the storefront go live as far as legal content goes. */
export function isLegalContentApproved(): boolean {
  return LEGAL_CONTENT_STATUS === 'approved';
}
