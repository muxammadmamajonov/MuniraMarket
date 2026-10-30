// @ts-check
/**
 * Telegram Serverless database schema.
 *
 * Business data (catalog, carts, orders, customers) lives in the Core API's PostgreSQL, NOT here.
 * The Serverless database only holds this bot's own operational configuration.
 *
 * Constraints of the platform DSL: no foreign keys (`.references()` / `foreignKey()` throw), and
 * deploying this file never changes the database; run `tgcloud migrate` separately.
 */
import { table, text, integer, sql } from 'sdk/db';

/**
 * Key/value operational config. Rows are provisioned MANUALLY by an operator and never committed
 * to the repository:
 *
 * | key                 | value                                                       | required |
 * | ------------------- | ----------------------------------------------------------- | -------- |
 * | `core_api_base_url` | origin of the Core API, https (http only for localhost)     | yes      |
 * | `service_key_id`    | key id, `[A-Za-z0-9_-]{1,32}` (X-MM-Key-Id)                 | yes      |
 * | `service_secret`    | HMAC signing secret, at least 32 bytes                      | yes      |
 * | `mini_app_url`      | https URL of the Main Mini App                              | no       |
 * | `bot_username`      | bot username without `@` (fallback `?startapp` link)        | no       |
 */
export const serviceConfig = table('service_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});
