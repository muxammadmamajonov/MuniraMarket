# Real-device and Telegram client UAT

Run on **staging** first, then a short pass on production. Use real hardware, not emulators.
Record device model, OS version, Telegram version and result for each row. Never use a real
customer's phone number or address: use a staff test account and a test address.

## Devices (minimum)

| Device                                          | Browser / client                             |
| ----------------------------------------------- | -------------------------------------------- |
| iPhone with notch / Dynamic Island, iOS current | Safari, Telegram iOS                         |
| Small iPhone (SE-size, 320-375 px wide)         | Safari, Telegram iOS                         |
| Mid-range Android (Android current - 2)         | Chrome, Telegram Android                     |
| Low-end Android (2-3 GB RAM)                    | Chrome, Telegram Android, slow 3G throttling |
| Desktop                                         | Telegram Desktop (Mini App), Chrome, Safari  |

## Storefront (browser)

- [ ] uz/ru switch keeps the page; all text translated; long Russian words do not overflow at 320 px.
- [ ] Catalog, category, search (2-letter query), product page, empty states, out-of-stock.
- [ ] Add to cart, change quantity, remove; tapping fast does not create duplicates; 99 cap.
- [ ] Sign in with the Login Widget (if enabled for the storefront); sign out.
- [ ] Checkout: district, address, phone `+998` formatting, slot day chips scroll horizontally
      only, keyboard does not hide the submit button, safe areas respected (notch, home bar).
- [ ] Slot taken by someone else meanwhile → clear notice, new choice, order succeeds.
- [ ] Airplane mode during submit → offline banner, no duplicate order after reconnect and retry.
- [ ] Rate limit (tap retry repeatedly) → readable wait message, buttons locked, recovers.
- [ ] Orders list and order detail; cancel a `NEW` order with a reason.
- [ ] Back/forward navigation, pull-to-refresh, rotate to landscape.
- [ ] Screen reader quick pass (VoiceOver, TalkBack): slot chips announced as tabs, windows as radios.

## Telegram Mini App

- [ ] Opens from the bot's menu button and from `/start`; theme (light/dark) follows Telegram.
- [ ] Signed in automatically (initData); no Login Widget shown inside Telegram.
- [ ] Telegram MainButton / BackButton behave on checkout; the bottom bar is not covered.
- [ ] Expand/collapse the sheet, rotate, switch apps and come back mid-checkout: state kept.
- [ ] Place an order; the status notification arrives in the chat in the chosen language.
- [ ] Telegram Desktop and Telegram Web (`web.telegram.org`): Mini App frames correctly.
- [ ] A link to the storefront opened outside Telegram shows the website flow, not Mini App UI.

## Admin (desktop and one phone)

- [ ] Sign in with the Login Widget on the admin hostname only; a customer account gets no access.
- [ ] Orders: list, filter, move through statuses, cancel with reason; second tab shows a conflict.
- [ ] Catalog: create/edit/archive/restore a product; image preview shows the placeholder (R2 off).
- [ ] CSV export, dry-run import, import; stale-row protection.
- [ ] Zones and slots; users (role change, block); audit log shows every change, no phone numbers.

## Performance and resilience

- [ ] First load of the storefront on mid-range Android over 4G under 3 s (LCP); record numbers.
- [ ] Cold start: after 30+ minutes idle on staging, the first API request still succeeds.
- [ ] During a staging deploy (rollout), browsing and checkout keep working.
