"""The back-office dashboard on a constructed dataset (real PostgreSQL, real migrations).

"Today" is the Asia/Tashkent (UTC+5) calendar day of the app clock, so orders around local
midnight (19:00 UTC) land on the right side of the boundary.
"""

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest_asyncio

from app.domain.order_status import OrderStatus
from app.models.enums import PaymentMethod, UserRole
from app.models.order import Order, OrderStatusHistory
from app.repositories.dashboard import SqlAlchemyDashboardRepository, tashkent_day_bounds
from app.repositories.users import UserRecord
from tests.conftest import FakeClock
from tests.db_data import TEST_USER_HEADER, SessionFactory, add_user, build_app
from tests.db_support import INTEGRATION_MARKS

pytest_plugins = ["tests.db_fixtures"]
pytestmark = INTEGRATION_MARKS

DASHBOARD = "/api/v1/admin/dashboard"
# 2026-11-01 00:30 in Tashkent: half an hour into the local day.
NOW = datetime(2026, 10, 31, 19, 30, tzinfo=UTC)
LOCAL_MIDNIGHT = datetime(2026, 10, 31, 19, 0, tzinfo=UTC)


async def add_order(
    factory: SessionFactory,
    user: UserRecord,
    *,
    created_at: datetime,
    total_uzs: int,
    status: OrderStatus = OrderStatus.NEW,
    cancelled_at: datetime | None = None,
) -> Order:
    order = Order(
        number=f"T-{uuid.uuid4().hex[:10]}",
        user_id=user.id,
        status=status,
        subtotal_uzs=total_uzs,
        delivery_fee_uzs=0,
        total_uzs=total_uzs,
        item_count=1,
        payment_method=PaymentMethod.CASH_ON_DELIVERY,
        recipient_name="Demo Mijoz",
        recipient_phone="+998001234567",
        address_snapshot={"district": "chilonzor", "street": "Demo", "house": "1"},
        cancel_reason="Demo sabab" if status is OrderStatus.CANCELLED else None,
        idempotency_key=uuid.uuid4().hex,
        idempotency_request_hash="0" * 64,
        created_at=created_at,
    )
    async with factory() as session:
        session.add(order)
        await session.flush()
        session.add(
            OrderStatusHistory(
                order_id=order.id,
                from_status=None,
                to_status=OrderStatus.NEW,
                actor_role=UserRole.CUSTOMER,
                created_at=created_at,
            )
        )
        if cancelled_at is not None:
            session.add(
                OrderStatusHistory(
                    order_id=order.id,
                    from_status=OrderStatus.NEW,
                    to_status=OrderStatus.CANCELLED,
                    actor_role=UserRole.OPERATOR,
                    reason="Demo sabab",
                    created_at=cancelled_at,
                )
            )
        await session.commit()
    return order


class Board:
    def __init__(
        self,
        client: httpx.AsyncClient,
        factory: SessionFactory,
        users: list[UserRecord],
        clock: FakeClock,
    ) -> None:
        self.client = client
        self.factory = factory
        self.operator, self.admin, self.customer = users
        self.clock = clock

    async def get(self, user: UserRecord | None = None) -> httpx.Response:
        return await self.client.get(
            DASHBOARD, headers={TEST_USER_HEADER: str((user or self.operator).id)}
        )


@pytest_asyncio.fixture(loop_scope="module")
async def board(session_factory: SessionFactory) -> AsyncIterator[Board]:
    users = [
        await add_user(session_factory, role=UserRole.OPERATOR),
        await add_user(session_factory, role=UserRole.ADMIN),
        await add_user(session_factory),
    ]
    clock = FakeClock(NOW.timestamp())
    app = build_app(session_factory, users, clock=clock)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=True)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield Board(client, session_factory, users, clock)


async def test_local_day_bounds() -> None:
    day, start, end = tashkent_day_bounds(NOW)
    assert day.isoformat() == "2026-11-01"
    assert (start, end) == (LOCAL_MIDNIGHT, LOCAL_MIDNIGHT + timedelta(days=1))
    # One second before local midnight is still the previous day.
    assert tashkent_day_bounds(LOCAL_MIDNIGHT - timedelta(seconds=1))[0].isoformat() == (
        "2026-10-31"
    )


async def test_empty_dashboard(board: Board) -> None:
    response = await board.get()
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "date": "2026-11-01",
        "timezone": "Asia/Tashkent",
        "orders_today": 0,
        "new_orders": 0,
        "gmv_today_uzs": 0,
        "average_order_value_uzs": 0,
        "cancelled_today": 0,
    }


async def test_figures_around_local_midnight(board: Board) -> None:
    customer, factory = board.customer, board.factory
    second = timedelta(seconds=1)
    # Today (local): exactly at midnight, NEW.
    await add_order(factory, customer, created_at=LOCAL_MIDNIGHT, total_uzs=100_000)
    # Yesterday, one second before local midnight (18:59:59 UTC): NEW, not today's.
    await add_order(factory, customer, created_at=LOCAL_MIDNIGHT - second, total_uzs=50_000)
    # Today, confirmed.
    await add_order(
        factory,
        customer,
        created_at=LOCAL_MIDNIGHT + timedelta(minutes=10),
        total_uzs=33_333,
        status=OrderStatus.CONFIRMED,
    )
    # Today, cancelled today: counted as placed, not in GMV, counted as cancelled today.
    await add_order(
        factory,
        customer,
        created_at=LOCAL_MIDNIGHT + timedelta(minutes=20),
        total_uzs=70_000,
        status=OrderStatus.CANCELLED,
        cancelled_at=LOCAL_MIDNIGHT + timedelta(minutes=25),
    )
    # Placed and cancelled yesterday (23:00 local): nothing today.
    await add_order(
        factory,
        customer,
        created_at=LOCAL_MIDNIGHT - timedelta(hours=9),
        total_uzs=80_000,
        status=OrderStatus.CANCELLED,
        cancelled_at=LOCAL_MIDNIGHT - timedelta(hours=1),
    )
    # Placed yesterday, cancelled just after midnight: a cancellation of today.
    await add_order(
        factory,
        customer,
        created_at=LOCAL_MIDNIGHT - timedelta(hours=7),
        total_uzs=90_000,
        status=OrderStatus.CANCELLED,
        cancelled_at=LOCAL_MIDNIGHT + timedelta(minutes=5),
    )
    # Tomorrow's local midnight is outside today (the end is exclusive); still NEW.
    await add_order(
        factory, customer, created_at=LOCAL_MIDNIGHT + timedelta(days=1), total_uzs=10_000
    )

    body = (await board.get()).json()
    assert body == {
        "date": "2026-11-01",
        "timezone": "Asia/Tashkent",
        "orders_today": 3,
        "new_orders": 3,
        "gmv_today_uzs": 133_333,
        # 133 333 / 2 = 66 666.5, rounded half up.
        "average_order_value_uzs": 66_667,
        "cancelled_today": 2,
    }

    # Same data, the clock one second before local midnight: "today" is the previous day.
    board.clock.now = (LOCAL_MIDNIGHT - second).timestamp()
    yesterday = (await board.get(board.admin)).json()
    assert yesterday["date"] == "2026-10-31"
    # Placed yesterday: the 50 000 NEW, 80 000 and 90 000 cancelled ones.
    assert (yesterday["orders_today"], yesterday["gmv_today_uzs"]) == (3, 50_000)
    assert yesterday["average_order_value_uzs"] == 50_000
    assert yesterday["cancelled_today"] == 1
    assert yesterday["new_orders"] == 3


async def test_average_rounds_half_up_and_down(board: Board) -> None:
    async def summary() -> tuple[int, int]:
        async with board.factory() as session:
            record = await SqlAlchemyDashboardRepository(session).summary(NOW)
        return record.gmv_today_uzs, record.average_order_value_uzs

    for total in (10_000, 10_001, 10_001):
        await add_order(board.factory, board.customer, created_at=NOW, total_uzs=total)
    assert await summary() == (30_002, 10_001)  # 10 000.67 rounds up
    await add_order(board.factory, board.customer, created_at=NOW, total_uzs=9_998)
    assert await summary() == (40_000, 10_000)  # exact
    await add_order(board.factory, board.customer, created_at=NOW, total_uzs=1)
    assert await summary() == (40_001, 8_000)  # 8 000.2 rounds down
    await add_order(board.factory, board.customer, created_at=NOW, total_uzs=7_999)
    assert await summary() == (48_000, 8_000)
    await add_order(board.factory, board.customer, created_at=NOW, total_uzs=4_004)
    assert await summary() == (52_004, 7_429)  # 7 429.14
    await add_order(board.factory, board.customer, created_at=NOW, total_uzs=4)
    assert await summary() == (52_008, 6_501)  # exactly 6 501.0


async def test_exact_half_rounds_up(board: Board) -> None:
    for total in (1, 2):  # 3 / 2 = 1.5
        await add_order(board.factory, board.customer, created_at=NOW, total_uzs=total)
    body = (await board.get()).json()
    assert (body["gmv_today_uzs"], body["average_order_value_uzs"]) == (3, 2)


async def test_only_staff_see_the_dashboard(board: Board) -> None:
    for user in (board.operator, board.admin):
        assert (await board.get(user)).status_code == 200
    response = await board.get(board.customer)
    body: dict[str, Any] = response.json()
    assert response.status_code == 403
    assert body["error"]["code"] == "forbidden"
