import 'server-only';

/**
 * How server code reaches the Core API. Under `next dev` / `next start` and in tests this is the
 * global `fetch` to `API_INTERNAL_URL`. The Cloudflare Workers build swaps this module for
 * `worker/upstream-fetch.ts`, which sends the same request through the `CORE_API` service
 * binding (see vite.config.ts).
 */
export const upstreamFetch: typeof fetch = (input, init) => fetch(input, init);
