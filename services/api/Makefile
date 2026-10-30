.PHONY: install lint format typecheck test run migrate seed build openapi

install:
	uv sync --locked

lint:
	uv run ruff check .
	uv run ruff format --check .

format:
	uv run ruff check --fix .
	uv run ruff format .

typecheck:
	uv run mypy

test:
	uv run pytest

# Local development only. Reads settings (including DATABASE_URL) from the environment or .env.
run:
	uv run uvicorn app.main:create_app --factory --reload --host 127.0.0.1 --port 8000

# Local development only: never point this at a shared or production database from a laptop.
migrate:
	uv run alembic upgrade head

# Local development only: inserts synthetic DEMO-* catalog data; refuses unless APP_ENV is
# development or test. Idempotent.
seed:
	uv run python -m app.dev.seed

# Build the wheel/sdist, then prove the built wheel installs and imports in a clean venv.
build:
	rm -rf dist
	uv build
	uv run --no-project --isolated --with dist/*.whl python -c "import app.main, app.models, app.security.service_auth; print('build ok')"

# Regenerate the OpenAPI document consumed by packages/contracts (no database or network needed).
openapi:
	uv run python -m app.dev.export_openapi ../../packages/contracts/openapi.json
