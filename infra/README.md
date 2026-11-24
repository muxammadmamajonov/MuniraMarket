# infra

Local development services and the **secret-free** blueprint for the cloud environments. Nothing
in this directory creates or changes a real resource; every value that identifies a real account,
host, database or credential is supplied by an operator at deploy time.

| Path                         | What                                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| `docker-compose.yml`         | Local PostgreSQL 17 on `127.0.0.1` (development only)              |
| [`cloudflare/`](cloudflare/) | Workers topology, environments, secrets, deploy, rollback          |
| [`neon/`](neon/)             | Database roles, TLS, pool limits, branches, backups, restore drill |
| [`r2/`](r2/)                 | Product image bucket: keys, MIME/size rules, lifecycle, enablement |
| [`launch/`](launch/)         | Launch gate, device/Telegram UAT and legal-content checklists      |

Design: [ADR 0011](../architecture/0011-cloudflare-neon-deployment.md), [ADR 0013](../architecture/0013-security-state-in-postgres.md) (no Redis: sessions, rate limits and nonces live in PostgreSQL).

## Local development

```bash
cp infra/.env.example infra/.env   # then set a local password
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d
docker compose -f infra/docker-compose.yml --env-file infra/.env down
```

## Environments

|             | local                          | staging                    | production                         |
| ----------- | ------------------------------ | -------------------------- | ---------------------------------- |
| Workers     | `next dev` or `*-dev` preview  | `muniramarket-*-staging`   | `muniramarket-*`                   |
| Core API    | `core-api-function` `pnpm dev` | none (no staging database) | Neon Function `coreapi`            |
| PostgreSQL  | Docker                         | not created for launch     | Neon `munira-market` (prod branch) |
| R2 bucket   | none                           | staging bucket (later)     | production bucket (later)          |
| Credentials | `.env` (git-ignored)           | staging secrets only       | production secrets only            |

Each environment's Workers bind only to that environment's gateway
(`muniramarket-api-gateway-<env>`), and each gateway holds only that environment's secrets. That
last part is a **convention, not a guarantee**: `CORE_API_FUNCTION_ORIGIN` is a free-form Worker
secret, so a staging gateway given the production Function's URL would serve production data. There
is one Neon project and no staging database (ADR 0013), so today nothing deploys staging at all.
The controls, in order of strength:

1. **Do not create staging until it has its own Neon project/branch and Function.** Never point a
   staging gateway at `coreapi` on the production branch.
2. **`validate-deploy-env.mts --mode staging` refuses** a deploy where
   `MM_CORE_API_FUNCTION_HOST` (the host the staging gateway secret points at, recorded by the
   operator) equals `MM_PRODUCTION_FUNCTION_HOST`. It cannot read the secret itself: it checks what
   the operator declares. Tested in `infra/cloudflare/test/deploy-env.test.ts`.
3. **Not done (needs a design decision, touches the gateway-to-Function auth):** the gateway sends
   its `APP_ENV` and the Function rejects a request whose environment differs from its own. That
   makes a mis-pointed secret fail closed instead of relying on step 2. See
   `infra/launch/p1-handoff.md` (O4).

Acceptance checks for a staging environment (all must pass before it is used):

- [ ] `neon functions get coreapi --branch <staging branch>` shows an `invocation_url` host
      different from production's; both hosts are recorded in the deploy env file.
- [ ] `node infra/cloudflare/scripts/validate-deploy-env.mts --mode staging` passes.
- [ ] `GET https://<staging API host>/api/v1/health/ready` is `200`, and creating a throwaway
      order on staging does **not** appear in the production database (check order counts on both
      sides before and after, as the owner/migrator, never with a customer's data).
- [ ] The staging gateway's `CORE_API_FUNCTION_SECRET` differs from production's, so a swapped
      origin is also refused by the Function (401).
- [ ] The staging Workers have no `workers.dev` or preview URL and no production secret.
