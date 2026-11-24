# O6: Cloudflare WAF, rate limits and alerts (handoff with exact parameters)

Nothing here is applied: it needs the Cloudflare dashboard (or an API token), which this repo does
not hold. The host names are the production ones (`MM_WEB_HOSTNAME`, `MM_ADMIN_HOSTNAME`,
`MM_API_HOSTNAME`); the API host is whatever `MM_API_HOSTNAME` is in the operator's records.

Plan limits differ (number of custom rules, rate-limit rules, the counting period and the block
duration on the Free plan are small). **Check the plan's limits first** and merge rules if you run
out; the priority order below says what to drop first.

**Start every rule in _Log_ (or _Managed Challenge_ for the auth rule), read Security Events for a
day, then switch to _Block_.** A rule that is too strict blocks real customers, and customers
behind a mobile carrier share a few IP addresses.

## Already in place (do not duplicate)

The API itself rate-limits per client (Postgres counters, ADR 0013), the gateway answers only an
allow-list of paths, and the API hostname serves only `/api/v1/health`, `/api/v1/health/ready`
and the service-signed routes. These Cloudflare rules are a second layer in front of that.

## 1. Rate-limit rules

| #   | Priority | Host and path (expression)                                                                                                  | Count by | Threshold           | Action (start / end)      |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------- | ------------------------- |
| R1  | high     | `http.host eq "<API host>" and starts_with(http.request.uri.path, "/api/v1/health")`                                        | IP       | 10 requests / 10 s  | Log / Block 1 min         |
| R2  | high     | `http.host in {"muniramarket.uz" "admin.muniramarket.uz"} and starts_with(http.request.uri.path, "/api/v1/auth/")`          | IP       | 20 requests / 1 min | Managed Challenge / Block |
| R3  | medium   | `http.host eq "<API host>" and starts_with(http.request.uri.path, "/api/v1/internal/")`                                     | IP       | 30 requests / 1 min | Log / Block 10 min        |
| R4  | low      | `http.host eq "muniramarket.uz" and http.request.method eq "POST" and starts_with(http.request.uri.path, "/api/v1/orders")` | IP       | 10 requests / 1 min | Log / Managed Challenge   |

R1 is the readiness protection: every `/health/ready` request that reaches the Function can touch
the database. The Function now answers from a 10-second in-isolate cache (ADR 0019), so the
database cost is bounded even without R1, but the Function invocation is not free.
Do **not** put the Telegram or gateway-cron traffic behind R1/R3: the gateway scheduler calls the
Function through a service binding, not through the public hostname, so these rules do not see it.

## 2. WAF

- Managed rules: **Cloudflare Managed Ruleset** on for the zone (Free plan: the free managed
  ruleset), **OWASP** if the plan offers it, in _Log_ first.
- Custom rule C1 (block): the API host serves GET only: `http.host eq "<API host>" and not
(http.request.method in {"GET" "POST"})`. (The two POST routes belong to Telegram Serverless.)
- Custom rule C2 (managed challenge): requests to the admin host from outside Uzbekistan,
  `http.host eq "admin.muniramarket.uz" and ip.geoip.country ne "UZ"`. Skip it if staff travel;
  Cloudflare Access (below) is the better control.
- Optional: **Cloudflare Access** in front of `admin.muniramarket.uz` (an email or IdP allow-list
  for staff) before the app's own Telegram sign-in. Free for up to 50 users.
- Bot protection: _Bot Fight Mode_ on the storefront zone. Do not enable it for the API host
  (Telegram and the gateway are legitimate non-browser clients).

## 3. Readiness endpoint restriction

- Done in code: `/api/v1/health/ready` caches a passing result for 10 s per isolate and never
  caches a failure (`services/core-api-function/src/readiness.ts`).
- Cloudflare side: R1 above; optionally cache `GET /api/v1/health/ready` for 10 s at the edge
  with a Cache Rule (_Eligible for cache_, Edge TTL 10 s, only for `200`), which removes nearly
  all public traffic from the Function.
- If you want it private: a WAF custom rule allowing it only from the monitoring provider's IPs
  (or a Cloudflare Health Check) and blocking the rest. The deploy smoke test (`smoke.mts --api`)
  and the uptime monitor must be on that allow-list.

## 4. Alerts (Notifications in the dashboard, or Workers Logs alert if on a paid plan)

| Alert                                                   | Condition                                                                                     | Send to                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Origin / Function down                                  | Health Check on `https://<API host>/api/v1/health/ready` fails 2 times in a row (every 1 min) | staff Telegram group via webhook, plus email |
| 5xx spike                                               | HTTP 5xx rate above 2 % for 5 min on the web or API host                                      | same                                         |
| DDoS / WAF event                                        | Advanced HTTP DDoS attack alert, "Security events" digest                                     | email                                        |
| Worker errors                                           | `muniramarket-api-gateway` error rate above 2 % for 5 min                                     | same                                         |
| Certificate / domain                                    | Universal SSL cert expiry notice, domain expiry                                               | email, 30 days ahead                         |
| Backup age (see `infra/neon/backup-restore-runbook.md`) | latest logical backup older than 26 h                                                         | same                                         |

## Acceptance

- [ ] R1-R3 exist, were in _Log_ for at least 24 h, and Security Events show no real customer hit.
- [ ] `curl` the readiness URL 30 times in 10 s from one machine: the first ones succeed, the rest
      are limited (R1) and the database does not show a matching query spike.
- [ ] A test notification from every alert above reaches the staff Telegram group or email.
- [ ] A forced failure (stop the health check target or point the monitor at a wrong path)
      triggers the "down" alert within 3 minutes, then recovers.
- [ ] The storefront still works from a mobile carrier network and from Telegram's in-app browser.

## Risk

Rate limits count by IP, so many customers behind one carrier IP can trip R2/R4: keep thresholds
generous and start in challenge mode. A WAF rule on the API host that blocks too much can cut off
Telegram Serverless or the deploy smoke test.
