# Core API image. Multi-stage: dependencies are resolved from uv.lock in the builder, the runtime
# stage only carries the virtualenv and the application code, and runs as an unprivileged user.

FROM python:3.13-slim AS builder
RUN pip install --no-cache-dir uv==0.13.6
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app

# Dependency layer: cached until pyproject.toml / uv.lock change.
COPY pyproject.toml uv.lock README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project

COPY app ./app
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable

FROM python:3.13-slim AS runtime
ARG APP_RELEASE=""
LABEL org.opencontainers.image.title="muniramarket-core-api" \
      org.opencontainers.image.revision="${APP_RELEASE}"
# Stamped on every log line (APP_RELEASE setting); empty for local builds.
ENV APP_RELEASE="${APP_RELEASE}"
# PGSSLROOTCERT: asyncpg only verifies the database server's certificate when it has a root
# certificate file; point it at the system CA bundle so ssl=verify-full (required outside
# development) authenticates Neon's publicly trusted certificate and hostname.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PGSSLROOTCERT=/etc/ssl/certs/ca-certificates.crt \
    PATH="/opt/venv/bin:$PATH"
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
WORKDIR /srv
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /app/app ./app
COPY alembic.ini ./
COPY alembic ./alembic
USER app
EXPOSE 8000
# Containers send SIGTERM before replacing or stopping an instance (up to 15 minutes before
# SIGKILL); uvicorn then stops accepting, finishes in-flight requests for at most 25 s, runs the
# lifespan shutdown (closes the pool and Redis) and exits.
STOPSIGNAL SIGTERM
# Configuration comes from the environment (see .env.example); nothing secret is baked in.
# --proxy-headers: the client IP (rate limits) is taken from X-Forwarded-For, but only when the
# peer is listed in FORWARDED_ALLOW_IPS, which uvicorn reads from the environment itself (exec
# form cannot expand variables). It is deliberately not defaulted here: the API refuses to start
# in staging/production without it, and uvicorn's own default is loopback only.
# --no-access-log: uvicorn's access log would record client IPs and query strings; the API
# writes its own structured access line (app/core/request_context.py) without them.
# --no-server-header: do not advertise the server software.
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--no-access-log", "--no-server-header", \
     "--timeout-graceful-shutdown", "25", "--timeout-keep-alive", "30"]
