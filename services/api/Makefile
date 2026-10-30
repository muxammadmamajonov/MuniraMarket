.PHONY: install lint format typecheck test run migrate build

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

# Build the wheel/sdist, then prove the built wheel installs and imports in a clean venv.
build:
	rm -rf dist
	uv build
	uv run --no-project --isolated --with dist/*.whl python -c "import app.main, app.models, app.security.service_auth; print('build ok')"
