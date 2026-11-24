/**
 * Back-office dashboard (`operator` and `admin`): today's figures in Asia/Tashkent time (port of
 * services/api/app/api/routes/admin_dashboard.py). "Today" is the local calendar day of the app
 * clock, so tests can pin it.
 */

import { backOfficeRouterDeps, rateLimit, requireStaff, RULES } from '../http/auth.ts';
import { deps, type Ctx } from '../http/context.ts';
import { DashboardRepository } from '../repositories/dashboard.ts';
import { json } from './adminCommon.ts';
import type { Router } from './index.ts';

async function dashboard(c: Ctx): Promise<Response> {
  await backOfficeRouterDeps(c);
  await rateLimit(c, RULES.ADMIN_READ, 'user');
  await requireStaff(c);
  const { db, clock } = deps(c);
  const record = await new DashboardRepository(db).summary(clock());
  return json({
    date: record.day,
    timezone: 'Asia/Tashkent',
    orders_today: record.orders_today,
    new_orders: record.new_orders,
    gmv_today_uzs: record.gmv_today_uzs,
    average_order_value_uzs: record.average_order_value_uzs,
    cancelled_today: record.cancelled_today,
  });
}

export function register(router: Router): void {
  router.get('/admin/dashboard', dashboard);
}
