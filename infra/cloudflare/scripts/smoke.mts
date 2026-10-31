#!/usr/bin/env node
/**
 * Post-deploy smoke test for the storefront, admin and Core API Workers. Needs no credentials and
 * contains no hostnames: pass them on the command line.
 *
 *   node infra/cloudflare/scripts/smoke.mts \
 *     --web https://<storefront host> --admin https://<admin host> --api https://<api host>
 *
 *   # CI / local: Workers previews without a running Core API (API-backed checks skipped)
 *   node infra/cloudflare/scripts/smoke.mts --local --web http://localhost:3100 \
 *     --admin http://localhost:3101
 *
 * Every check is read-only (GET, or a POST the API must refuse); nothing is created.
 */

type Check = { name: string; run: () => Promise<void> };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1]?.replace(/\/+$/, '');
}

const local = process.argv.includes('--local');
const web = arg('web');
const admin = arg('admin');
const api = arg('api');
if (!web || !admin) {
  console.error('usage: smoke.mts --web URL --admin URL [--api URL] [--local]');
  process.exit(2);
}
for (const url of [web, admin, api]) {
  if (url && !local && !url.startsWith('https://')) {
    console.error(`refusing non-https URL outside --local: ${url}`);
    process.exit(2);
  }
}

class CheckError extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckError(message);
}

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init });
}

function directives(csp: string | null): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of (csp ?? '').split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name.toLowerCase(), values);
  }
  return map;
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

const checks: Check[] = [
  {
    name: 'storefront page: CSP with nonce, Telegram framing, base headers',
    run: async () => {
      const response = await get(`${web}/uz`);
      expect(response.status === 200, `status ${response.status}`);
      const csp = directives(response.headers.get('content-security-policy'));
      const script = csp.get('script-src') ?? [];
      expect(
        script.some((v) => v.startsWith("'nonce-")),
        'script-src has no nonce',
      );
      expect(!script.includes("'unsafe-inline'"), "script-src allows 'unsafe-inline'");
      expect(local || !script.includes("'unsafe-eval'"), "script-src allows 'unsafe-eval'");
      const ancestors = csp.get('frame-ancestors') ?? [];
      expect(ancestors.includes('https://web.telegram.org'), 'Telegram Web cannot frame the app');
      expect(!ancestors.includes('*'), 'frame-ancestors allows everyone');
      expect(csp.get('object-src')?.includes("'none'"), "object-src is not 'none'");
      expect(response.headers.get('x-content-type-options') === 'nosniff', 'no nosniff');
      expect(response.headers.get('referrer-policy') !== null, 'no Referrer-Policy');
      expect(response.headers.get('x-powered-by') === null, 'X-Powered-By is sent');
      expect(
        !/\bpublic\b/.test(response.headers.get('cache-control') ?? ''),
        'HTML page is publicly cacheable',
      );
      await response.body?.cancel();
    },
  },
  {
    name: 'storefront proxy hides admin and internal routes',
    run: async () => {
      for (const path of ['admin/orders', 'internal/telegram/notifications/claim', '%61dmin/x']) {
        const response = await get(`${web}/api/v1/${path}`);
        expect(response.status === 404, `${path}: status ${response.status}`);
        expect(response.headers.get('cache-control')?.includes('no-store'), `${path}: cacheable`);
        await response.body?.cancel();
      }
    },
  },
  {
    name: 'admin page: no framing, no indexing, no external images',
    run: async () => {
      const response = await get(`${admin}/uz`);
      expect(response.status === 200, `status ${response.status}`);
      const csp = directives(response.headers.get('content-security-policy'));
      expect(csp.get('frame-ancestors')?.join(' ') === "'none'", "frame-ancestors is not 'none'");
      const images = csp.get('img-src') ?? [];
      expect(
        !images.some((v) => v === 'https:' || v === '*' || v.startsWith('http')),
        `img-src allows external images: ${images.join(' ')}`,
      );
      expect(response.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options is not DENY');
      expect(response.headers.get('x-robots-tag')?.includes('noindex'), 'admin is indexable');
      expect(response.headers.get('cache-control')?.includes('no-store'), 'admin page cacheable');
      await response.body?.cancel();
    },
  },
  {
    name: 'admin proxy refuses storefront and Mini App routes',
    run: async () => {
      const products = await get(`${admin}/api/v1/products`);
      expect(products.status === 404, `products: status ${products.status}`);
      const initData = await get(`${admin}/api/v1/auth/telegram/init-data`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: admin },
        body: '{}',
      });
      expect(initData.status === 404, `init-data: status ${initData.status}`);
      await products.body?.cancel();
      await initData.body?.cancel();
    },
  },
];

if (!local) {
  checks.push(
    {
      name: 'Core API reachable through the storefront (health, readiness, catalog)',
      run: async () => {
        for (const path of ['health', 'health/ready', 'categories', 'delivery/zones']) {
          const response = await get(`${web}/api/v1/${path}`);
          expect(response.status === 200, `${path}: status ${response.status}`);
          await response.body?.cancel();
        }
      },
    },
    {
      name: 'session routes refuse anonymous and cross-site requests',
      run: async () => {
        const session = await get(`${web}/api/v1/auth/session`);
        expect(session.status === 401, `session: status ${session.status}`);
        expect((await errorCode(session)) === 'session_required', 'session: wrong error code');
        expect(session.headers.get('cache-control')?.includes('no-store'), 'session: cacheable');
        const cart = await get(`${web}/api/v1/cart/items`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
          body: JSON.stringify({ product_id: '00000000-0000-0000-0000-000000000000', quantity: 1 }),
        });
        expect([401, 403].includes(cart.status), `cross-site cart write: status ${cart.status}`);
        await cart.body?.cancel();
      },
    },
    {
      name: 'admin sign-in configuration is served',
      run: async () => {
        const response = await get(`${admin}/api/v1/auth/config`);
        expect(response.status === 200, `status ${response.status}`);
        const body = (await response.json()) as { telegram_login_widget?: { enabled?: boolean } };
        expect(body.telegram_login_widget?.enabled === true, 'Login Widget is not enabled');
      },
    },
  );
  if (api) {
    checks.push({
      name: 'public API hostname: health only, signed routes refuse unsigned calls',
      run: async () => {
        const health = await get(`${api}/api/v1/health`);
        expect(health.status === 200, `health: status ${health.status}`);
        expect(health.headers.get('x-request-id'), 'no X-Request-ID on API responses');
        await health.body?.cancel();
        for (const path of ['products', 'openapi.json', 'docs', 'admin/orders', 'auth/session']) {
          const response = await get(`${api}/api/v1/${path}`);
          expect(response.status === 404, `${path}: status ${response.status}`);
          await response.body?.cancel();
        }
        const claim = await get(`${api}/api/v1/internal/telegram/notifications/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"limit":1}',
        });
        expect(claim.status === 401, `unsigned claim: status ${claim.status}`);
        await claim.body?.cancel();
      },
    });
  }
}

let failed = 0;
for (const check of checks) {
  try {
    await check.run();
    console.log(`PASS  ${check.name}`);
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL  ${check.name}: ${message}`);
  }
}
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
