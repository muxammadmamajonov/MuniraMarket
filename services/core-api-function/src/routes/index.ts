import type { Hono, Handler } from 'hono';
import type { AppBindings } from '../http/context.ts';
import { API_PREFIX } from '../http/body.ts';

/**
 * Route registration. Each module under src/routes exports `register(router)`; `router.get(...)`
 * etc. take the path BELOW `/api/v1` in FastAPI form (`/orders/{order_id}`), so paths can be
 * compared 1:1 with packages/contracts/openapi.json (test/unit/contract.test.ts).
 */

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RegisteredRoute {
  method: Method;
  /** OpenAPI form, with the `/api/v1` prefix: `/api/v1/orders/{order_id}`. */
  path: string;
}

export interface Router {
  get(path: string, handler: Handler<AppBindings>): void;
  post(path: string, handler: Handler<AppBindings>): void;
  put(path: string, handler: Handler<AppBindings>): void;
  patch(path: string, handler: Handler<AppBindings>): void;
  delete(path: string, handler: Handler<AppBindings>): void;
}

export const registered: RegisteredRoute[] = [];

function toHono(path: string): string {
  return path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1');
}

export function createRouter(app: Hono<AppBindings>, record = true): Router {
  const add =
    (method: Method) =>
    (path: string, handler: Handler<AppBindings>): void => {
      const full = `${API_PREFIX}${path}`;
      if (record && !registered.some((r) => r.method === method && r.path === full)) {
        registered.push({ method, path: full });
      }
      app.on(method, toHono(full), async (c, next) => {
        c.set('routeTemplate', full);
        return handler(c, next);
      });
    };
  return {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
  };
}

import * as health from './health.ts';
import * as auth from './auth.ts';
import * as internalTelegram from './internalTelegram.ts';
import * as internalNotifications from './internalNotifications.ts';
import * as internalStaffChat from './internalStaffChat.ts';
import * as internalMaintenance from './internalMaintenance.ts';
import * as internalScheduler from './internalScheduler.ts';
import * as catalog from './catalog.ts';
import * as delivery from './delivery.ts';
import * as cart from './cart.ts';
import * as orders from './orders.ts';
import * as adminOrders from './adminOrders.ts';
import * as adminDelivery from './adminDelivery.ts';
import * as adminDashboard from './adminDashboard.ts';
import * as adminCatalog from './adminCatalog.ts';
import * as adminCsv from './adminCsv.ts';
import * as adminUsers from './adminUsers.ts';
import * as adminAudit from './adminAudit.ts';

/** Same order as services/api/app/api/router.py (static paths before parameterised ones). */
const MODULES: ReadonlyArray<{ register(router: Router): void }> = [
  health,
  auth,
  internalTelegram,
  internalNotifications,
  internalStaffChat,
  internalMaintenance,
  internalScheduler,
  catalog,
  delivery,
  cart,
  orders,
  adminOrders,
  adminDelivery,
  adminDashboard,
  adminCatalog,
  adminCsv,
  adminUsers,
  adminAudit,
];

export function registerRoutes(app: Hono<AppBindings>): void {
  const router = createRouter(app);
  for (const module of MODULES) module.register(router);
}
