"""Audit log reads (``admin`` role only). The log is append-only; there is no write route."""

import uuid
from typing import Annotated

from fastapi import Depends, Query

from app.api.admin_deps import ADMIN_READ_LIMIT, AdminDep, back_office_router
from app.api.deps import SessionDep
from app.core.errors import error_responses
from app.repositories.audit import AuditFilter, AuditRepository, SqlAlchemyAuditRepository
from app.schemas.audit import AuditPage

MAX_PAGE_SIZE = 100
DEFAULT_PAGE_SIZE = 50
MAX_PAGE = 100_000

router = back_office_router("/admin/audit", tags=["admin-audit"])


def get_audit_repository(session: SessionDep) -> AuditRepository:
    return SqlAlchemyAuditRepository(session)


AuditRepositoryDep = Annotated[AuditRepository, Depends(get_audit_repository)]


@router.get(
    "",
    response_model=AuditPage,
    dependencies=[Depends(ADMIN_READ_LIMIT)],
    responses=error_responses(401, 403, 422, 429, 503),
)
async def list_audit_entries(  # noqa: PLR0917 - FastAPI injects every parameter
    _: AdminDep,
    audit: AuditRepositoryDep,
    entity_type: Annotated[
        str | None, Query(pattern=r"^[a-z_]{1,32}$", examples=["product"])
    ] = None,
    entity_id: Annotated[str | None, Query(min_length=1, max_length=64)] = None,
    action: Annotated[
        str | None, Query(pattern=r"^[a-z_]{1,32}\.[a-z_]{1,31}$", examples=["product.update"])
    ] = None,
    actor_user_id: uuid.UUID | None = None,
    page: Annotated[int, Query(ge=1, le=MAX_PAGE)] = 1,
    page_size: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
) -> AuditPage:
    """Audit entries, newest first, optionally filtered."""
    record = await audit.list_entries(
        AuditFilter(
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            actor_user_id=actor_user_id,
        ),
        page=page,
        page_size=page_size,
    )
    return AuditPage.from_record(record, page=page, page_size=page_size)
