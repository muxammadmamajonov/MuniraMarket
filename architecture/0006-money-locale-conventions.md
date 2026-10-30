# ADR 0006 — Money, locale and time conventions

- Status: accepted

- Money is stored and transported as integer UZS (`BIGINT` in PostgreSQL, safe integers in
  TypeScript). Floats are never used for amounts. Formatting groups thousands with a no-break space
  and appends `so‘m` (uz) or `сум` (ru); it is implemented without relying on ICU locale data.
- Supported locales are `uz` (default) and `ru`. The website keeps the choice in a `locale` cookie;
  the bot picks `ru` for Russian Telegram clients and `uz` otherwise. Dictionaries are typed so both
  languages must define the same keys.
- Timestamps are stored as `timestamptz` in UTC; presentation uses `Asia/Tashkent`.
- Orders snapshot product name, SKU, unit and price at creation time.
