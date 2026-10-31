"""Write the API's ``.env`` from the variables ``neon deploy`` pulled into the repo root.

``python -m app.dev.neon_env [path/to/.env.local]``

``neon deploy`` / ``neon env pull`` write Neon's own names (``DATABASE_URL_UNPOOLED``,
``AWS_*``, ``NEON_AUTH_*``) to ``<repo>/.env.local``. The API reads ``services/api/.env`` with its
own names, so this maps one onto the other and leaves every other key in ``.env`` as it was (a
missing ``.env`` starts from ``.env.example``). Both files are git-ignored; no value is printed.
"""

import sys
from collections.abc import Callable, Mapping
from pathlib import Path

from app.db.neon_url import asyncpg_url_from_neon

API_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = API_ROOT.parents[1]
DEFAULT_SOURCE = REPO_ROOT / ".env.local"
TARGET = API_ROOT / ".env"
EXAMPLE = API_ROOT / ".env.example"
# The bucket declared in neon.ts (``buckets.assets``).
NEON_BUCKET = "assets"

# API variable <- (Neon variable, transform)
MAPPING: dict[str, tuple[str, Callable[[str], str]]] = {
    "DATABASE_URL": ("DATABASE_URL_UNPOOLED", asyncpg_url_from_neon),
    "NEON_AUTH_BASE_URL": ("NEON_AUTH_BASE_URL", str),
    "NEON_AUTH_JWKS_URL": ("NEON_AUTH_JWKS_URL", str),
    "OBJECT_STORAGE_ENDPOINT_URL": ("AWS_ENDPOINT_URL_S3", str),
    "OBJECT_STORAGE_REGION": ("AWS_REGION", str),
    "OBJECT_STORAGE_ACCESS_KEY_ID": ("AWS_ACCESS_KEY_ID", str),
    "OBJECT_STORAGE_SECRET_ACCESS_KEY": ("AWS_SECRET_ACCESS_KEY", str),
}


def parse_dotenv(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        values[key.strip()] = value.strip().strip("'\"")
    return values


def api_values(neon: Mapping[str, str]) -> dict[str, str]:
    missing = [source for source, _ in MAPPING.values() if not neon.get(source)]
    if missing:
        raise ValueError(f"missing Neon variables: {', '.join(missing)} (run `neon deploy`)")
    values = {target: convert(neon[source]) for target, (source, convert) in MAPPING.items()}
    values["OBJECT_STORAGE_BUCKET"] = NEON_BUCKET
    return values


def merge(existing: str, updates: Mapping[str, str]) -> str:
    """Replace the given keys in place; append the ones the file does not have yet."""
    pending = dict(updates)
    lines: list[str] = []
    for line in existing.splitlines():
        key = line.split("=", 1)[0].strip().removeprefix("# ").strip()
        if "=" in line and key in pending:
            lines.append(f"{key}={pending.pop(key)}")
        else:
            lines.append(line)
    if pending:
        lines += ["", "# --- Neon (written by `python -m app.dev.neon_env`) ---"]
        lines += [f"{key}={value}" for key, value in pending.items()]
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    source = Path(argv[0]) if argv else DEFAULT_SOURCE
    try:
        values = api_values(parse_dotenv(source.read_text(encoding="utf-8")))
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"neon_env: {exc}\n")
        return 1
    base = TARGET if TARGET.exists() else EXAMPLE
    TARGET.write_text(merge(base.read_text(encoding="utf-8"), values), encoding="utf-8")
    sys.stdout.write(f"wrote {', '.join(sorted(values))} to {TARGET}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
