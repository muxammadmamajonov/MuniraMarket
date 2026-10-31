"""Back-office dashboard figures, computed in SQL for the Asia/Tashkent calendar day."""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Protocol

from sqlalchemy import BigInteger, Numeric, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.delivery import tashkent_date, tashkent_instant
from app.domain.order_status import OrderStatus
from app.models.order import Order, OrderStatusHistory


@dataclass(frozen=True, slots=True)
class DashboardRecord:
    day: date
    orders_today: int
    new_orders: int
    gmv_today_uzs: int
    average_order_value_uzs: int
    cancelled_today: int


class DashboardRepository(Protocol):
    async def summary(self, now: datetime) -> DashboardRecord: ...


def tashkent_day_bounds(now: datetime) -> tuple[date, datetime, datetime]:
    """The local date of ``now`` and its ``[start, end)`` instants."""
    day = tashkent_date(now)
    start = tashkent_instant(day, time(0, 0))
    return day, start, start + timedelta(days=1)


class SqlAlchemyDashboardRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def summary(self, now: datetime) -> DashboardRecord:
        """One round trip; each figure is an index-friendly scalar subquery.

        * ``orders_today``: orders created today (local day), any status.
        * ``gmv_today_uzs`` / AOV: today's orders that are not cancelled; the average is rounded
          half up (``round`` on numeric) and ``0`` without such orders.
        * ``new_orders``: every order currently ``NEW``, whenever it was placed.
        * ``cancelled_today``: cancellations recorded today (whenever the order was placed).
        """
        day, start, end = tashkent_day_bounds(now)
        today = (Order.created_at >= start) & (Order.created_at < end)
        kept = today & (Order.status != OrderStatus.CANCELLED)

        orders_today = select(func.count()).select_from(Order).where(today).scalar_subquery()
        kept_count = select(func.count()).select_from(Order).where(kept).scalar_subquery()
        gmv = (
            select(func.coalesce(func.sum(Order.total_uzs), 0))
            .select_from(Order)
            .where(kept)
            .scalar_subquery()
        )
        new_orders = (
            select(func.count())
            .select_from(Order)
            .where(Order.status == OrderStatus.NEW)
            .scalar_subquery()
        )
        cancelled_today = (
            select(func.count())
            .select_from(OrderStatusHistory)
            .where(
                OrderStatusHistory.to_status == OrderStatus.CANCELLED,
                OrderStatusHistory.created_at >= start,
                OrderStatusHistory.created_at < end,
            )
            .scalar_subquery()
        )
        row = (
            await self._session.execute(
                select(
                    orders_today.label("orders_today"),
                    new_orders.label("new_orders"),
                    cast(gmv, BigInteger).label("gmv"),
                    cast(
                        func.coalesce(
                            func.round(cast(gmv, Numeric) / func.nullif(kept_count, 0)), 0
                        ),
                        BigInteger,
                    ).label("aov"),
                    cancelled_today.label("cancelled_today"),
                )
            )
        ).one()
        return DashboardRecord(
            day=day,
            orders_today=row.orders_today,
            new_orders=row.new_orders,
            gmv_today_uzs=row.gmv,
            average_order_value_uzs=row.aov,
            cancelled_today=row.cancelled_today,
        )
