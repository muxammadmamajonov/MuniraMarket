"""Back-office dashboard (``operator`` and ``admin``): today's figures in Asia/Tashkent time.

"Today" is the local calendar day of the app clock (``request.app.state.clock``), so tests can
pin it. Every response is ``Cache-Control: no-store``.
"""

from typing import Annotated

from fastapi import Depends

from app.api.admin_deps import ADMIN_READ_LIMIT, StaffDep, back_office_router
from app.api.deps import SessionDep
from app.api.routes.orders import NowDep
from app.core.errors import error_responses
from app.repositories.dashboard import DashboardRepository, SqlAlchemyDashboardRepository
from app.schemas.dashboard import Dashboard

router = back_office_router("/admin/dashboard", tags=["admin"])


def get_dashboard_repository(session: SessionDep) -> DashboardRepository:
    return SqlAlchemyDashboardRepository(session)


DashboardRepositoryDep = Annotated[DashboardRepository, Depends(get_dashboard_repository)]


@router.get(
    "",
    response_model=Dashboard,
    dependencies=[Depends(ADMIN_READ_LIMIT)],
    responses=error_responses(401, 403, 429, 503),
)
async def dashboard(_: StaffDep, repository: DashboardRepositoryDep, now: NowDep) -> Dashboard:
    """Orders and revenue of the current Asia/Tashkent day, and the orders waiting now."""
    return Dashboard.from_record(await repository.summary(now))
