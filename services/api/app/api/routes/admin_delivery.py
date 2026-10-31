"""Admin: delivery zones and delivery slots (``admin`` role only).

Operators get ``403 forbidden`` like customers, before anything is read (no IDOR oracle). Every
route is behind ``back_office_router`` (Login Widget session, ``admin_ip``); reads use
``admin_read`` and writes ``admin_write`` plus the CSRF token. Each change writes its audit row
in the same transaction. Every response is ``Cache-Control: no-store``.
"""

import logging
import uuid
from datetime import date
from typing import Annotated

from fastapi import Depends, Query, Response

from app.api.admin_deps import (
    ADMIN_READ_LIMIT,
    ADMIN_WRITE_LIMIT,
    AdminDep,
    AdminWriterDep,
    actor_of,
    back_office_router,
)
from app.api.deps import SessionDep
from app.core.errors import ApiError, error_responses
from app.repositories.admin_delivery import (
    AdminDeliveryError,
    AdminDeliveryRepository,
    CapacityBelowReservedError,
    DistrictTakenError,
    InvalidValueError,
    SlotExistsError,
    SlotInUseError,
    SlotNotFoundError,
    SqlAlchemyAdminDeliveryRepository,
    ZoneInUseError,
    ZoneNotFoundError,
    ZoneSlugTakenError,
)
from app.schemas.admin_delivery import (
    DeliverySlotAdmin,
    DeliverySlotAdminList,
    DeliveryZoneAdmin,
    DeliveryZoneAdminList,
    SlotCreateRequest,
    SlotUpdateRequest,
    ZoneCreateRequest,
    ZoneUpdateRequest,
)

logger = logging.getLogger("app.admin.delivery")

router = back_office_router("/admin/delivery", tags=["admin"])


def get_admin_delivery_repository(session: SessionDep) -> AdminDeliveryRepository:
    return SqlAlchemyAdminDeliveryRepository(session)


AdminDeliveryRepositoryDep = Annotated[
    AdminDeliveryRepository, Depends(get_admin_delivery_repository)
]


def to_api_error(exc: AdminDeliveryError) -> ApiError:  # noqa: PLR0911 - one branch per rule
    if isinstance(exc, DistrictTakenError):
        return ApiError(
            409, "district_taken", "District belongs to another zone", district=exc.district
        )
    if isinstance(exc, InvalidValueError):
        return ApiError(
            422,
            "validation_error",
            "Request validation failed",
            details=[{"loc": ["body", exc.field], "msg": exc.message}],
        )
    if isinstance(exc, ZoneNotFoundError):
        return ApiError(404, "zone_not_found", "Delivery zone not found")
    if isinstance(exc, SlotNotFoundError):
        return ApiError(404, "slot_not_found", "Delivery slot not found")
    if isinstance(exc, ZoneSlugTakenError):
        return ApiError(409, "slug_taken", "Another zone uses this slug")
    if isinstance(exc, ZoneInUseError):
        return ApiError(409, "zone_in_use", "Orders or slots use this zone; deactivate it instead")
    if isinstance(exc, SlotExistsError):
        return ApiError(409, "slot_exists", "The zone already has a slot starting then")
    if isinstance(exc, SlotInUseError):
        return ApiError(409, "slot_in_use", "Places in this slot are booked")
    if isinstance(exc, CapacityBelowReservedError):
        return ApiError(
            409, "capacity_below_reserved", "Capacity is below the places already booked"
        )
    return ApiError(500, "internal_error", "Internal server error")  # pragma: no cover


# --- zones ----------------------------------------------------------------------------------------


@router.get(
    "/zones",
    response_model=DeliveryZoneAdminList,
    dependencies=[Depends(ADMIN_READ_LIMIT)],
    responses=error_responses(401, 403, 429, 503),
)
async def list_zones(_: AdminDep, repository: AdminDeliveryRepositoryDep) -> DeliveryZoneAdminList:
    """Every zone (inactive ones too), in display order, with its districts."""
    return DeliveryZoneAdminList(
        items=[DeliveryZoneAdmin.from_record(zone) for zone in await repository.list_zones()]
    )


@router.post(
    "/zones",
    response_model=DeliveryZoneAdmin,
    status_code=201,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 409, 422, 429, 503),
)
async def create_zone(
    payload: ZoneCreateRequest, admin: AdminWriterDep, repository: AdminDeliveryRepositoryDep
) -> DeliveryZoneAdmin:
    """``409 district_taken`` (with ``district``) when a district already belongs to a zone."""
    values = payload.model_dump(exclude={"districts"})
    try:
        record = await repository.create_zone(
            values, frozenset(payload.districts), actor=actor_of(admin)
        )
    except AdminDeliveryError as exc:
        raise to_api_error(exc) from None
    logger.info("Delivery zone created: %s", record.id)
    return DeliveryZoneAdmin.from_record(record)


@router.patch(
    "/zones/{zone_id}",
    response_model=DeliveryZoneAdmin,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 404, 409, 422, 429, 503),
)
async def update_zone(
    zone_id: uuid.UUID,
    payload: ZoneUpdateRequest,
    admin: AdminWriterDep,
    repository: AdminDeliveryRepositoryDep,
) -> DeliveryZoneAdmin:
    """Change only the fields sent; ``districts`` replaces the zone's whole district set."""
    try:
        record = await repository.update_zone(zone_id, payload.changes(), actor=actor_of(admin))
    except AdminDeliveryError as exc:
        raise to_api_error(exc) from None
    logger.info("Delivery zone updated: %s", zone_id)
    return DeliveryZoneAdmin.from_record(record)


@router.delete(
    "/zones/{zone_id}",
    status_code=204,
    response_class=Response,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 404, 409, 422, 429, 503),
)
async def delete_zone(
    zone_id: uuid.UUID, admin: AdminWriterDep, repository: AdminDeliveryRepositoryDep
) -> Response:
    """Only a zone no order and no slot refers to (``409 zone_in_use``); else deactivate it."""
    try:
        await repository.delete_zone(zone_id, actor=actor_of(admin))
    except AdminDeliveryError as exc:
        raise to_api_error(exc) from None
    logger.info("Delivery zone deleted: %s", zone_id)
    return Response(status_code=204)


# --- slots ----------------------------------------------------------------------------------------


@router.get(
    "/slots",
    response_model=DeliverySlotAdminList,
    dependencies=[Depends(ADMIN_READ_LIMIT)],
    responses=error_responses(401, 403, 422, 429, 503),
)
async def list_slots(
    _: AdminDep,
    repository: AdminDeliveryRepositoryDep,
    zone_id: uuid.UUID | None = None,
    date_from: Annotated[date | None, Query(description="Local date, inclusive")] = None,
    date_to: Annotated[date | None, Query(description="Local date, inclusive")] = None,
) -> DeliverySlotAdminList:
    """Slots by date and start time, optionally of one zone and a date range (at most 1000)."""
    if date_from is not None and date_to is not None and date_to < date_from:
        raise ApiError(
            422,
            "validation_error",
            "Request validation failed",
            details=[{"loc": ["query", "date_to"], "msg": "date_to must not be before date_from"}],
        )
    record = await repository.list_slots(zone_id=zone_id, date_from=date_from, date_to=date_to)
    return DeliverySlotAdminList(
        items=[DeliverySlotAdmin.from_record(slot) for slot in record.items],
        truncated=record.truncated,
    )


@router.post(
    "/slots",
    response_model=DeliverySlotAdmin,
    status_code=201,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 404, 409, 422, 429, 503),
)
async def create_slot(
    payload: SlotCreateRequest, admin: AdminWriterDep, repository: AdminDeliveryRepositoryDep
) -> DeliverySlotAdmin:
    """``cutoff_at`` may not be after the slot starts (Asia/Tashkent); ``409 slot_exists`` when
    the zone already has a slot starting at that date and time."""
    try:
        record = await repository.create_slot(payload.model_dump(), actor=actor_of(admin))
    except AdminDeliveryError as exc:
        raise to_api_error(exc) from None
    logger.info("Delivery slot created: %s", record.id)
    return DeliverySlotAdmin.from_record(record)


@router.patch(
    "/slots/{slot_id}",
    response_model=DeliverySlotAdmin,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 404, 409, 422, 429, 503),
)
async def update_slot(
    slot_id: uuid.UUID,
    payload: SlotUpdateRequest,
    admin: AdminWriterDep,
    repository: AdminDeliveryRepositoryDep,
) -> DeliverySlotAdmin:
    """Change only the fields sent. ``409 capacity_below_reserved`` below the booked places;
    ``409 slot_in_use`` when moving (date/times) a slot with booked places."""
    try:
        record = await repository.update_slot(slot_id, payload.changes(), actor=actor_of(admin))
    except AdminDeliveryError as exc:
        raise to_api_error(exc) from None
    logger.info("Delivery slot updated: %s", slot_id)
    return DeliverySlotAdmin.from_record(record)


@router.delete(
    "/slots/{slot_id}",
    status_code=204,
    response_class=Response,
    dependencies=[Depends(ADMIN_WRITE_LIMIT)],
    responses=error_responses(401, 403, 404, 409, 422, 429, 503),
)
async def delete_slot(
    slot_id: uuid.UUID, admin: AdminWriterDep, repository: AdminDeliveryRepositoryDep
) -> Response:
    """Only a slot with nothing booked and no order referring to it (``409 slot_in_use``)."""
    try:
        await repository.delete_slot(slot_id, actor=actor_of(admin))
    except AdminDeliveryError as exc:
        raise to_api_error(exc) from None
    logger.info("Delivery slot deleted: %s", slot_id)
    return Response(status_code=204)
