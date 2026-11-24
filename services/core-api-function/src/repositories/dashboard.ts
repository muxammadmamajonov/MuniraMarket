/**
 * Back-office dashboard figures, computed in SQL for the Asia/Tashkent calendar day (port of
 * services/api/app/repositories/dashboard.py).
 */

import type { Database } from '../db.ts';
import { tashkentDate, tashkentInstant } from '../domain/tashkentTime.ts';

export interface DashboardRecord {
  day: string;
  orders_today: number;
  new_orders: number;
  gmv_today_uzs: number;
  average_order_value_uzs: number;
  cancelled_today: number;
}

/** The local date of `nowEpochSeconds` and its `[start, end)` instants (epoch seconds). */
export function tashkentDayBounds(nowEpochSeconds: number): [string, number, number] {
  const day = tashkentDate(nowEpochSeconds);
  const start = tashkentInstant(day, '00:00');
  return [day, start, start + 24 * 60 * 60];
}

export class DashboardRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * One round trip; each figure is an index-friendly scalar subquery.
   * - `orders_today`: orders created today (local day), any status;
   * - `gmv_today_uzs` / AOV: today's orders that are not cancelled; the average is rounded half
   *   up (`round` on numeric) and 0 without such orders;
   * - `new_orders`: every order currently `NEW`, whenever it was placed;
   * - `cancelled_today`: cancellations recorded today (whenever the order was placed).
   */
  async summary(nowEpochSeconds: number): Promise<DashboardRecord> {
    const [day, start, end] = tashkentDayBounds(nowEpochSeconds);
    const { rows } = await this.db.query<Omit<DashboardRecord, 'day'>>(
      `WITH bounds AS (SELECT to_timestamp($1) AS start_at, to_timestamp($2) AS end_at)
       SELECT
         (SELECT count(*) FROM orders o, bounds b
           WHERE o.created_at >= b.start_at AND o.created_at < b.end_at) AS orders_today,
         (SELECT count(*) FROM orders o WHERE o.status = 'NEW') AS new_orders,
         CAST((SELECT coalesce(sum(o.total_uzs), 0) FROM orders o, bounds b
           WHERE o.created_at >= b.start_at AND o.created_at < b.end_at
             AND o.status <> 'CANCELLED') AS BIGINT) AS gmv_today_uzs,
         CAST(coalesce(round(
           CAST((SELECT coalesce(sum(o.total_uzs), 0) FROM orders o, bounds b
                 WHERE o.created_at >= b.start_at AND o.created_at < b.end_at
                   AND o.status <> 'CANCELLED') AS NUMERIC)
           / nullif((SELECT count(*) FROM orders o, bounds b
                     WHERE o.created_at >= b.start_at AND o.created_at < b.end_at
                       AND o.status <> 'CANCELLED'), 0)), 0) AS BIGINT) AS average_order_value_uzs,
         (SELECT count(*) FROM order_status_history h, bounds b
           WHERE h.to_status = 'CANCELLED' AND h.created_at >= b.start_at
             AND h.created_at < b.end_at) AS cancelled_today`,
      [start, end],
    );
    const row = rows[0] as Omit<DashboardRecord, 'day'>;
    return { day, ...row };
  }
}
