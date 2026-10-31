"""Catalog CSV template, export and import (``admin`` only). Format: ``app/domain/catalog_csv``.

The import body is the raw CSV (``Content-Type: text/csv``), at most 1 MiB (enforced by
``BodySizeLimitMiddleware`` before this route runs, also for chunked uploads) and 2000 product
rows. A file with any error writes nothing: the response is ``200`` with ``applied: false`` and
the row errors, so the admin UI can show them. ``dry_run=true`` never writes. Uploaded contents
are never logged.
"""

import logging
from typing import Annotated, Any

from fastapi import Depends, Query, Request, Response

from app.api.admin_deps import (
    ADMIN_READ_LIMIT,
    ADMIN_WRITE_LIMIT,
    AdminDep,
    AdminWriterDep,
    actor_of,
    back_office_router,
)
from app.api.auth_deps import rate_limit
from app.api.routes.admin_catalog import AdminCatalogRepositoryDep, to_api_error
from app.core.errors import ApiError, error_responses
from app.domain.catalog_csv import CsvFileError, parse_catalog_csv, render_csv, render_template
from app.domain.delivery import TASHKENT_TZ, utc_now_from
from app.repositories.admin_catalog import AdminCatalogError
from app.schemas.admin_catalog import CsvImportResult
from app.security.rate_limit import ADMIN_CSV_EXPORT, ADMIN_CSV_IMPORT

logger = logging.getLogger("app.admin.csv")

CSV_MEDIA_TYPE = "text/csv; charset=utf-8"

# Module-level so tests can replace these exact dependency objects in ``dependency_overrides``.
ADMIN_CSV_IMPORT_LIMIT = rate_limit(
    ADMIN_CSV_IMPORT.scope, ADMIN_CSV_IMPORT.limit, ADMIN_CSV_IMPORT.window_seconds, key="user"
)
ADMIN_CSV_EXPORT_LIMIT = rate_limit(
    ADMIN_CSV_EXPORT.scope, ADMIN_CSV_EXPORT.limit, ADMIN_CSV_EXPORT.window_seconds, key="user"
)

router = back_office_router("/admin/catalog/csv", tags=["admin-catalog"])

_CSV_RESPONSE: dict[int | str, dict[str, Any]] = {
    200: {
        "description": "UTF-8 CSV with BOM and CRLF line endings",
        "content": {"text/csv": {"schema": {"type": "string"}}},
    }
}
_CSV_BODY: dict[str, Any] = {
    "requestBody": {
        "required": True,
        "description": "The CSV file itself (UTF-8, at most 1 MiB and 2000 product rows)",
        "content": {"text/csv": {"schema": {"type": "string"}}},
    }
}


def _csv_response(content: bytes, filename: str) -> Response:
    return Response(
        content=content,
        media_type=CSV_MEDIA_TYPE,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get(
    "/template",
    response_class=Response,
    dependencies=[Depends(ADMIN_READ_LIMIT)],
    responses={**_CSV_RESPONSE, **error_responses(401, 403, 429, 503)},
)
async def csv_template(_: AdminDep) -> Response:
    """An empty import file: just the header row."""
    return _csv_response(render_template(), "catalog-template.csv")


@router.get(
    "/export",
    response_class=Response,
    dependencies=[Depends(ADMIN_READ_LIMIT), Depends(ADMIN_CSV_EXPORT_LIMIT)],
    responses={**_CSV_RESPONSE, **error_responses(401, 403, 429, 503)},
)
async def csv_export(request: Request, _: AdminDep, catalog: AdminCatalogRepositoryDep) -> Response:
    """Every non-archived product, by SKU. Cells a spreadsheet would run as a formula are
    prefixed with ``'`` (import removes it again)."""
    rows = await catalog.export_rows()
    today = utc_now_from(request.app.state.clock()).astimezone(TASHKENT_TZ)
    return _csv_response(render_csv(rows), f"catalog-{today:%Y%m%d}.csv")


def _is_csv(content_type: str | None) -> bool:
    media_type = (content_type or "").split(";", 1)[0].strip().lower()
    return media_type in ("text/csv", "application/csv")


@router.post(
    "/import",
    response_model=CsvImportResult,
    dependencies=[Depends(ADMIN_WRITE_LIMIT), Depends(ADMIN_CSV_IMPORT_LIMIT)],
    responses=error_responses(401, 403, 409, 413, 415, 422, 429, 503),
    openapi_extra=_CSV_BODY,
)
async def csv_import(
    request: Request,
    admin: AdminWriterDep,
    catalog: AdminCatalogRepositoryDep,
    dry_run: Annotated[bool, Query(description="Validate only; never writes")] = False,
) -> CsvImportResult:
    """Create or update products by SKU from a CSV file, all or nothing.

    File-level problems are ``422`` (``csv_invalid_encoding``, ``csv_invalid_header``,
    ``csv_malformed``, ``csv_too_many_rows``); a body over 1 MiB is ``413``. Row problems are
    returned in ``errors`` (at most 200) with ``applied: false``.
    """
    if not _is_csv(request.headers.get("content-type")):
        raise ApiError(415, "unsupported_media_type", "Send the file as text/csv")
    raw = await request.body()
    try:
        parsed = parse_catalog_csv(raw)
    except CsvFileError as exc:
        raise ApiError(
            422,
            exc.code,
            exc.message,
            details=[{"loc": ["body", location], "msg": msg} for location, msg in exc.details],
        ) from None
    try:
        outcome = await catalog.import_csv(parsed, dry_run=dry_run, actor=actor_of(admin))
    except AdminCatalogError as exc:
        raise to_api_error(exc) from None
    logger.info(
        "CSV import: rows=%d applied=%s dry_run=%s errors=%d",
        outcome.total_rows,
        outcome.applied,
        dry_run,
        len(outcome.errors),
    )
    return CsvImportResult.from_outcome(outcome)
