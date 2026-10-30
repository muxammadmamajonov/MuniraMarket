# infra

Local development services only (PostgreSQL 17, Redis 8), bound to `127.0.0.1`.

```bash
cp infra/.env.example infra/.env   # then set a local password
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d
docker compose -f infra/docker-compose.yml --env-file infra/.env down
```

Deployment, DNS and production configuration are intentionally not stored here.
