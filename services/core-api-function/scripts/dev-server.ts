/**
 * LOCAL DEVELOPMENT / E2E ONLY: serves the Core API Function on http://127.0.0.1:8000 (same URL
 * the FastAPI reference used), standing in for the Cloudflare gateway the way the web and admin
 * apps' `API_INTERNAL_URL` expects in `next dev` / `next start`.
 *
 * Like the gateway it drops any caller-sent `X-MM-Gateway-Secret` and adds its own, generated
 * per process (never written anywhere). It refuses to start unless APP_ENV is development or
 * test, so it can never front a deployed database. Production traffic only ever reaches the
 * Function through services/api-gateway.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { createApp } from '../src/app.ts';
import { loadSettings } from '../src/config.ts';
import { createPool, Database } from '../src/db.ts';
import { systemClock } from '../src/http/context.ts';
import { GATEWAY_SECRET_HEADER } from '../src/http/gatewaySecret.ts';
import { createLogger } from '../src/logging.ts';

const appEnv = process.env['APP_ENV'];
if (appEnv !== 'development' && appEnv !== 'test') {
  console.error('dev-server: refusing to start unless APP_ENV is development or test');
  process.exit(1);
}

const secret = randomBytes(32).toString('base64url');
const env = {
  ...process.env,
  // The FastAPI reference's local URL uses the asyncpg driver name; pg wants plain postgresql.
  DATABASE_URL: process.env['DATABASE_URL']?.replace(/^postgresql\+asyncpg:/, 'postgresql:'),
  CORE_API_FUNCTION_SECRET: secret,
};
const settings = loadSettings(env);
const pool = createPool(settings.databaseUrl);
const app = createApp({
  settings,
  db: new Database(pool, { runtimeRole: settings.dbRuntimeRole }),
  clock: systemClock,
  logger: createLogger({ level: settings.logLevel, env: settings.appEnv }),
  fetch: (input, init) => fetch(input, init),
});

async function toRequest(req: IncomingMessage, port: number): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.toLowerCase() === GATEWAY_SECRET_HEADER) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set(GATEWAY_SECRET_HEADER, secret);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  const method = req.method ?? 'GET';
  return new Request(`http://127.0.0.1:${port}${req.url ?? '/'}`, {
    method,
    headers,
    ...(body && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
  });
}

const port = Number(process.env['PORT'] ?? 8000);
const host = process.env['HOST'] ?? '127.0.0.1';
createServer((req, res) => {
  void (async () => {
    try {
      const response = await app.fetch(await toRequest(req, port));
      const headers: Record<string, string | string[]> = {};
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') headers[name] = value;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) headers['set-cookie'] = cookies;
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"internal_error","message":"Internal server error"}}');
    }
  })();
}).listen(port, host, () => {
  console.log(JSON.stringify({ msg: `core-api function dev server on http://${host}:${port}` }));
});
