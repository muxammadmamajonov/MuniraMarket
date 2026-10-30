# ADR 0005 — Order status notification delivery

- Status: open

## Context

Customers must receive a Telegram message when their order status changes. Status changes happen
in Core API (operator/admin actions). Telegram Serverless code only runs for incoming Telegram
updates and Mini App endpoint calls; its documentation describes no scheduler and no way for an
external system to invoke a module.

## Current state

- `services/telegram/tgcloud/lib/notifications/orderStatus.js` builds and sends the localized
  message and treats "user blocked the bot" as a non-fatal outcome.
- No trigger is wired. Nothing in the repository pretends one exists.

## Options to decide in the checkout/order phase

1. Core API sends through the Bot API directly (needs the bot token in Core API's secret store);
   Serverless keeps the message templates in sync via shared fixtures.
2. Core API writes a notification outbox; Serverless drains it when it next runs (update traffic,
   operator actions in a Telegram chat). Simple, but delivery latency depends on traffic.
3. A platform-supported trigger, if Telegram documents one.
