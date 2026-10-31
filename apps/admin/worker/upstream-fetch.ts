import { env } from 'cloudflare:workers';

/**
 * Workers replacement for `src/lib/api/upstream-fetch.ts` (swapped in by vite.config.ts).
 *
 * Deployed, every server-side Core API request goes through the `CORE_API` service binding to the
 * gateway's `AdminApi` entrypoint: no public hop, and the gateway only accepts back-office
 * routes. In local Workers development there is no binding and the request goes to
 * `API_INTERNAL_URL` (the developer's API) as under `next dev`.
 */
export const upstreamFetch: typeof fetch = (input, init) => {
  // Declared only for deployed modes (cloudflare.config.ts), so read it as optional.
  const binding = (env as { CORE_API?: Fetcher }).CORE_API;
  return binding ? binding.fetch(input, init) : fetch(input, init);
};
