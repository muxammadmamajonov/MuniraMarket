"""Back-office dashboard response. Money is integer UZS; ``date`` is the Asia/Tashkent day."""

import datetime as dt
from typing import Literal, Self

from pydantic import BaseModel

from app.repositories.dashboard import DashboardRecord


class Dashboard(BaseModel):
    date: dt.date
    timezone: Literal["Asia/Tashkent"] = "Asia/Tashkent"
    # Orders placed today (any status).
    orders_today: int
    # Orders waiting for confirmation right now (placed on any day).
    new_orders: int
    # Total of today's orders that are not cancelled.
    gmv_today_uzs: int
    # ``gmv_today_uzs`` / their count, rounded half up; ``0`` when there are none.
    average_order_value_uzs: int
    # Cancellations recorded today (of orders placed on any day).
    cancelled_today: int

    @classmethod
    def from_record(cls, record: DashboardRecord) -> Self:
        return cls(
            date=record.day,
            orders_today=record.orders_today,
            new_orders=record.new_orders,
            gmv_today_uzs=record.gmv_today_uzs,
            average_order_value_uzs=record.average_order_value_uzs,
            cancelled_today=record.cancelled_today,
        )
