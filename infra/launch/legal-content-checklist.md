# Legal content checklist (privacy, offer, delivery, returns, contacts)

The repository contains **no legal wording**. `apps/web/src/lib/legal/` defines the contract every
page must satisfy (required sections, uz and ru, version, effective date, approving role) and a
validator; `LEGAL_CONTENT_STATUS` stays `'pending'` until the business supplies approved text.
The launch gate blocks production while it is pending.

## Who

- Text: written or reviewed by a lawyer qualified for Uzbekistan consumer, e-commerce and personal
  data law. Engineering never drafts legal text.
- Approval: the business owner or director (`approvedBy` records the role, not a name).

## Per page

| Page (slug) | Must cover (section ids in `contract.ts`)                               |
| ----------- | ----------------------------------------------------------------------- |
| `privacy`   | operator, dataCollected, purposes, sharing, retention, rights, contact  |
| `offer`     | parties, subject, ordering, pricing, liability, disputes, sellerDetails |
| `delivery`  | zones, fees, slots, receiving, problems                                 |
| `returns`   | conditions, process, refunds, exceptions                                |
| `contacts`  | seller, address, channels, hours                                        |

The section list is an engineering proposal; the lawyer may rename, add or remove sections in
`contract.ts` together with the content.

## Facts the lawyer needs from the business (not from engineering guesses)

- [ ] Legal entity name, registration and tax ids, legal and actual address, bank details for the
      offer's seller section.
- [ ] Personal data actually processed: Telegram id, name, username, language; delivery address
      and recipient phone; order history; technical logs (no IPs or phone numbers in application
      logs, see services/api/README.md). Where it is stored (Neon region, Cloudflare, Redis
      provider region) and for how long.
- [ ] Personal data localisation requirements for citizens of Uzbekistan, and whether the chosen
      database/Redis regions satisfy them or a local copy is needed. **Decide before launch.**
- [ ] Processors: Cloudflare, Neon, the Redis provider, Telegram.
- [ ] Payment terms (cash/card on delivery only at launch), delivery zones/fees/minimums/slots
      as configured in the admin, cancellation rules (customer may cancel `NEW`/`CONFIRMED`).
- [ ] Returns policy for food and non-food goods, refund method and deadlines.
- [ ] Contact channels and working hours.

## Before publishing

- [ ] Content for every page in uz and ru passes `validateLegalContent` (unit test with the real
      content), version and effective date set.
- [ ] Pages routed and linked from the storefront footer, checkout (offer acceptance wording next
      to the order button) and the bot's `/start` message if required.
- [ ] `LEGAL_CONTENT_STATUS` flipped to `'approved'` in the same pull request as the content.
- [ ] The previous version is kept (history) when the text changes; customers see the effective
      date.
