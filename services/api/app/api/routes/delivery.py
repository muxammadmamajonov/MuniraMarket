"""Public delivery zones (no authentication), cached like the catalog and limited per IP."""

from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.deps import SessionDep
from app.api.routes.catalog import CATALOG_IP_LIMIT, public_cache
from app.api.routes.orders import NowDep
from app.core.errors import error_responses
from app.repositories.delivery import DeliveryZoneRepository, SqlAlchemyDeliveryZoneRepository
from app.schemas.delivery import DeliveryZoneList, DeliveryZonePublic

router = APIRouter(
    prefix="/delivery",
    tags=["delivery"],
    dependencies=[Depends(CATALOG_IP_LIMIT), Depends(public_cache)],
)


def get_delivery_zone_repository(session: SessionDep) -> DeliveryZoneRepository:
    return SqlAlchemyDeliveryZoneRepository(session)


DeliveryZoneRepositoryDep = Annotated[DeliveryZoneRepository, Depends(get_delivery_zone_repository)]


@router.get("/zones", response_model=DeliveryZoneList, responses=error_responses(429, 503))
async def list_zones(zones: DeliveryZoneRepositoryDep, now: NowDep) -> DeliveryZoneList:
    """Active zones with their districts, fees, minimum order and Asia/Tashkent hours.

    ``is_open_now`` is as of the response; it may be up to a minute stale from a cache.
    """
    return DeliveryZoneList(
        items=[DeliveryZonePublic.from_record(zone, now) for zone in await zones.list_active()]
    )
