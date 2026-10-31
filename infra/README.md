# infra

Local development services and the **secret-free** blueprint for the cloud environments. Nothing
in this directory creates or changes a real resource; every value that identifies a real account,
host, database or credential is supplied by an operator at deploy time.

| Path                         | What                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `docker-compose.yml`         | Local PostgreSQL 17 and Redis 8 on `127.0.0.1` (development only)    |
| [`cloudflare/`](cloudflare/) | Workers/Containers topology, environments, secrets, deploy, rollback |
| [`neon/`](neon/)             | Database roles, TLS, pool limits, branches, backups, restore drill   |
| [`redis/`](redis/)           | Managed Redis: TLS, key prefixes, isolation, eviction                |
| [`r2/`](r2/)                 | Product image bucket: keys, MIME/size rules, lifecycle, enablement   |
| [`launch/`](launch/)         | Launch gate, device/Telegram UAT and legal-content checklists        |

Design: [ADR 0011](../architecture/0011-cloudflare-neon-deployment.md).

## Local development

```bash
cp infra/.env.example infra/.env   # then set a local password
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d
docker compose -f infra/docker-compose.yml --env-file infra/.env down
```

## Environments

|             | local                         | staging                        | production                      |
| ----------- | ----------------------------- | ------------------------------ | ------------------------------- |
| Workers     | `next dev` or `*-dev` preview | `muniramarket-*-staging`       | `muniramarket-*`                |
| Core API    | `make run` / Docker           | Container, `APP_ENV=staging`   | Container, `APP_ENV=production` |
| PostgreSQL  | Docker                        | Neon project (staging)         | Neon project (production)       |
| Redis       | Docker                        | managed, own instance/ACL user | managed, own instance/ACL user  |
| R2 bucket   | none                          | staging bucket (later)         | production bucket (later)       |
| Credentials | `.env` (git-ignored)          | staging secrets only           | production secrets only         |

A staging or preview build can never reach production resources: each environment's Workers
bind only to that environment's gateway (`muniramarket-api-gateway-<env>`), and each gateway holds
only that environment's secrets.
