"""Write the Core API OpenAPI document deterministically (input for ``packages/contracts``).

Usage: ``python -m app.dev.export_openapi <output.json>`` (or ``-`` for stdout).

The settings below are fixed placeholders so the output never depends on the local environment;
no database, Redis or network connection is opened.
"""

import json
import sys
from pathlib import Path
from typing import Any

from app.core.config import Settings
from app.main import create_app

_PLACEHOLDER_SETTINGS: dict[str, Any] = {
    "app_env": "test",
    "database_url": "postgresql+asyncpg://openapi:openapi@127.0.0.1:1/openapi",
    "redis_url": "redis://127.0.0.1:1/0",
    "cors_allowed_origins": [],
    "service_auth_keys": "openapi:openapi-export-placeholder-not-a-secret",
    "telegram_bot_id": 1,
    "telegram_environment": "test",
}


def render_openapi() -> str:
    app = create_app(Settings.model_validate(_PLACEHOLDER_SETTINGS))
    return json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: python -m app.dev.export_openapi <output.json|->\n")
        return 2
    document = render_openapi()
    if argv[1] == "-":
        sys.stdout.write(document)
    else:
        Path(argv[1]).write_text(document, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
