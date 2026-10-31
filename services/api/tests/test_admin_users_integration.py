"""User management over HTTP against a real PostgreSQL schema.

The last-admin rule is checked with real concurrent requests (separate database sessions), and
blocking is checked end to end with real sessions.
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest_asyncio
from sqlalchemy import func, select, update

from app.models.audit import AuditLog
from app.models.enums import UserRole
from app.models.user import User
from app.repositories.users import UserRecord
from tests.admin_factories import (
    audit_rows,
    build_admin_app,
    build_session_app,
    error_of,
    widget_session,
)
from tests.auth_helpers import http_client
from tests.db_data import TEST_USER_HEADER, SessionFactory, add_user
from tests.db_support import INTEGRATION_MARKS

pytest_plugins = ["tests.db_fixtures"]
pytestmark = INTEGRATION_MARKS

USERS = "/api/v1/admin/users"
DEMO_PHONE = "+998901234567"


@dataclass
class Office:
    client: httpx.AsyncClient
    factory: SessionFactory
    first: UserRecord
    second: UserRecord
    customer: UserRecord

    async def patch(self, actor: UserRecord, target: UserRecord, **body: Any) -> httpx.Response:
        return await self.client.patch(
            f"{USERS}/{target.id}", json=body, headers={TEST_USER_HEADER: str(actor.id)}
        )

    async def state(self, user: UserRecord) -> tuple[UserRole, bool]:
        async with self.factory() as session:
            row = (
                await session.execute(select(User.role, User.is_blocked).where(User.id == user.id))
            ).one()
            return row.role, row.is_blocked

    async def active_admins(self) -> int:
        async with self.factory() as session:
            return (
                await session.execute(
                    select(func.count())
                    .select_from(User)
                    .where(User.role == UserRole.ADMIN, User.is_blocked.is_(False))
                )
            ).scalar_one()

    async def reset(self) -> None:
        async with self.factory() as session:
            await session.execute(
                update(User)
                .where(User.id.in_([self.first.id, self.second.id]))
                .values(role=UserRole.ADMIN, is_blocked=False)
            )
            await session.commit()


@pytest_asyncio.fixture(loop_scope="module")
async def office(session_factory: SessionFactory) -> AsyncIterator[Office]:
    first = await add_user(session_factory, role=UserRole.ADMIN)
    second = await add_user(session_factory, role=UserRole.ADMIN)
    customer = await add_user(session_factory)
    async with session_factory() as session:
        await session.execute(update(User).where(User.id == customer.id).values(phone=DEMO_PHONE))
        await session.commit()
    app = build_admin_app(session_factory, [first, second, customer])
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=True)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield Office(client, session_factory, first, second, customer)


async def test_the_last_admin_cannot_remove_themselves(office: Office) -> None:
    # Two admins: one may step down...
    response = await office.patch(office.second, office.second, role="operator")
    assert response.status_code == 200, response.text
    assert response.json()["role"] == "operator"
    # ...but the remaining one cannot, nor be demoted or blocked by anyone else.
    error_of(await office.patch(office.first, office.first, role="customer"), 409, "last_admin")
    error_of(
        await office.patch(office.first, office.first, is_blocked=True), 409, "cannot_block_self"
    )
    assert await office.state(office.first) == (UserRole.ADMIN, False)
    assert await office.active_admins() == 1
    # Promoting someone else first makes the step down possible.
    assert (await office.patch(office.first, office.customer, role="admin")).status_code == 200
    assert (await office.patch(office.first, office.first, role="operator")).status_code == 200
    assert await office.active_admins() == 1


async def test_cannot_block_self_even_with_other_admins(office: Office) -> None:
    error_of(
        await office.patch(office.first, office.first, is_blocked=True), 409, "cannot_block_self"
    )
    assert await office.state(office.first) == (UserRole.ADMIN, False)


async def test_blocking_an_admin_counts_as_removing_one(office: Office) -> None:
    assert (await office.patch(office.first, office.second, is_blocked=True)).status_code == 200
    assert await office.active_admins() == 1
    # A blocked admin is not an active admin; unblocking restores it.
    assert (await office.patch(office.first, office.second, is_blocked=False)).status_code == 200
    assert await office.active_admins() == 2
    rows = await audit_rows(office.factory, AuditLog.entity_id == str(office.second.id))
    assert [(row.action, row.details) for row in rows] == [
        ("user.block", {"changes": {"is_blocked": {"from": False, "to": True}}}),
        ("user.unblock", {"changes": {"is_blocked": {"from": True, "to": False}}}),
    ]


async def test_two_admins_demoting_each_other_concurrently(office: Office) -> None:
    for kind in ({"role": "customer"}, {"is_blocked": True}, {"role": "operator"}):
        for _ in range(5):
            await office.reset()
            responses = await asyncio.gather(
                office.patch(office.first, office.second, **kind),
                office.patch(office.second, office.first, **kind),
            )
            statuses = sorted(response.status_code for response in responses)
            assert statuses == [200, 409], [response.text for response in responses]
            loser = next(response for response in responses if response.status_code == 409)
            assert loser.json()["error"]["code"] == "last_admin"
            assert await office.active_admins() == 1


async def test_role_change_is_audited_without_personal_data(office: Office) -> None:
    response = await office.patch(office.first, office.customer, role="operator")
    assert response.status_code == 200
    body = response.json()
    assert "phone" not in body
    assert DEMO_PHONE not in response.text
    [row] = await audit_rows(office.factory, AuditLog.action == "user.role_change")
    assert row.entity_type == "user"
    assert row.entity_id == str(office.customer.id)
    assert row.actor_user_id == office.first.id
    assert row.details == {"changes": {"role": {"from": "customer", "to": "operator"}}}
    # A no-op change is accepted but not audited.
    again = await office.patch(office.first, office.customer, role="operator")
    assert again.status_code == 200
    assert len(await audit_rows(office.factory)) == 1


async def test_unknown_user_is_404(office: Office) -> None:
    response = await office.client.patch(
        f"{USERS}/{uuid.uuid4()}",
        json={"role": "admin"},
        headers={TEST_USER_HEADER: str(office.first.id)},
    )
    error_of(response, 404, "user_not_found")


async def test_list_and_search(office: Office) -> None:
    async with office.factory() as session:
        await session.execute(
            update(User)
            .where(User.id == office.customer.id)
            .values(first_name="Dilnoza", last_name="Demo_100%", username="dilnoza_demo")
        )
        await session.commit()
    headers = {TEST_USER_HEADER: str(office.first.id)}

    async def ids(**params: Any) -> list[str]:
        response = await office.client.get(USERS, params=params, headers=headers)
        assert response.status_code == 200, response.text
        assert DEMO_PHONE not in response.text
        return [item["id"] for item in response.json()["items"]]

    everyone = await ids()
    assert len(everyone) == 3
    assert set(everyone) == {str(office.first.id), str(office.second.id), str(office.customer.id)}
    assert await ids(q="dilNOZA") == [str(office.customer.id)]
    assert await ids(q="100%") == [str(office.customer.id)]
    assert await ids(q="_100") == [str(office.customer.id)]
    assert await ids(q="%") == [str(office.customer.id)]
    assert await ids(q=str(office.customer.telegram_user_id)) == [str(office.customer.id)]
    assert await ids(q=str(office.customer.telegram_user_id)[:-1]) == []
    assert set(await ids(role="admin")) == {str(office.first.id), str(office.second.id)}
    assert await ids(blocked="true") == []
    page = (await office.client.get(USERS, params={"page_size": 2}, headers=headers)).json()
    assert (page["total"], page["total_pages"], len(page["items"])) == (3, 2, 2)


async def test_blocked_user_is_refused_on_the_next_request(
    session_factory: SessionFactory,
) -> None:
    admin = await add_user(session_factory, role=UserRole.ADMIN)
    customer = await add_user(session_factory)
    app = build_session_app(session_factory)
    async with http_client(app) as client:
        staff = await widget_session(app, admin)
        shopper = await app.state.session_manager.create(
            user_id=customer.id,
            telegram_user_id=customer.telegram_user_id,
            auth_method="telegram_init_data",
        )
        shopper_cookie = {"Cookie": f"__Host-mm_session={shopper.token}"}
        assert (await client.get("/api/v1/cart", headers=shopper_cookie)).status_code == 200

        # Without the CSRF token the block is refused; with it, it applies.
        response = await client.patch(
            f"{USERS}/{customer.id}", json={"is_blocked": True}, headers=staff.cookie
        )
        error_of(response, 403, "csrf_failed")
        response = await client.patch(
            f"{USERS}/{customer.id}", json={"is_blocked": True}, headers=staff.csrf
        )
        assert response.status_code == 200, response.text
        assert response.json()["is_blocked"] is True

        error_of(await client.get("/api/v1/cart", headers=shopper_cookie), 403, "account_blocked")
        # The session was revoked as well.
        error_of(await client.get("/api/v1/cart", headers=shopper_cookie), 401, "session_required")
