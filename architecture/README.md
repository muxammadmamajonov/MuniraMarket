# Architecture notes

Short, public decision records. Product plans, business data and operational details are kept
outside this repository.

| #                                              | Decision                                   | Status             |
| ---------------------------------------------- | ------------------------------------------ | ------------------ |
| [0001](0001-monorepo-and-stack.md)             | Monorepo layout and stack                  | accepted           |
| [0002](0002-telegram-serverless-boundary.md)   | Telegram Serverless vs. Core API boundary  | accepted           |
| [0003](0003-service-auth-contract.md)          | Service-to-service request signing         | accepted           |
| [0004](0004-telegram-identity-verification.md) | Telegram identity verification in Core API | accepted           |
| [0005](0005-order-notifications-delivery.md)   | Order status notification delivery         | superseded by 0008 |
| [0006](0006-money-locale-conventions.md)       | Money, locale and time conventions         | accepted           |
| [0007](0007-browser-sessions-csrf.md)          | Browser sessions, CSRF and rate limiting   | accepted           |
| [0008](0008-order-notification-outbox.md)      | Order notifications via an outbox          | accepted           |
| [0009](0009-checkout-orders.md)                | Checkout, zones, idempotent orders, stock  | accepted           |
