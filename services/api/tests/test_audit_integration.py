"""The audit log on a real PostgreSQL schema: no personal data or secrets ever reach it, it is
append-only (database trigger), and admins can read it newest first with filters."""

import csv
import io
import json
import uuid

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.exc import DBAPIError

from app.audit import AuditActor, record_audit
from app.domain.catalog_csv import BOM, COLUMNS
from app.models.audit import AuditLog
from app.models.enums import UserRole
from app.models.user import User
from tests.admin_factories import CSV_HEADERS, build_session_app, widget_session
from tests.auth_helpers import http_client
from tests.db_data import SessionFactory, add_category, add_product, add_user
from tests.db_support import INTEGRATION_MARKS

pytest_plugins = ["tests.db_fixtures"]
pytestmark = INTEGRATION_MARKS

DEMO_PHONE = "+998901234567"
FIRST_NAME = "Shahzoda"
LAST_NAME = "Karimova"
USERNAME = "shahzoda_k_demo"


async def test_audit_log_never_contains_personal_data(session_factory: SessionFactory) -> None:
    admin = await add_user(session_factory, telegram_user_id=700_100_200, role=UserRole.ADMIN)
    customer = await add_user(session_factory, telegram_user_id=700_100_300)
    async with session_factory() as session:
        await session.execute(
            update(User)
            .where(User.id == customer.id)
            .values(phone=DEMO_PHONE, first_name=FIRST_NAME, last_name=LAST_NAME, username=USERNAME)
        )
        await session.execute(
            update(User)
            .where(User.id == admin.id)
            .values(phone="+998977654321", first_name="Admin", username="admin_demo")
        )
        await session.commit()
    category = await add_category(session_factory, "mevalar")
    product = await add_product(session_factory, category, "olma", sku="DEMO-OLMA")

    app = build_session_app(session_factory)
    async with http_client(app) as client:
        staff = await widget_session(app, admin)
        cookie_token = staff.cookie["Cookie"].split("=", 1)[1]
        csrf_token = staff.csrf["X-CSRF-Token"]
        for method, path, body in (
            ("PATCH", f"/api/v1/admin/users/{customer.id}", {"role": "operator"}),
            ("PATCH", f"/api/v1/admin/users/{customer.id}", {"is_blocked": True}),
            ("PATCH", f"/api/v1/admin/users/{customer.id}", {"is_blocked": False}),
            (
                "PATCH",
                f"/api/v1/admin/products/{product.id}",
                {"price_uzs": 11_000, "description_uz": f"{FIRST_NAME} {DEMO_PHONE}"},
            ),
            (
                "POST",
                "/api/v1/admin/categories",
                {"slug": "sut", "name_uz": "Sut", "name_ru": "Moloko"},
            ),
        ):
            response = await client.request(method, path, json=body, headers=staff.csrf)
            assert response.status_code in (200, 201), response.text

        buffer = io.StringIO(newline="")
        writer = csv.writer(buffer, lineterminator="\r\n")
        writer.writerow(COLUMNS)
        writer.writerow(
            [
                "DEMO-NEW",
                "",
                "mevalar",
                "Yangi",
                "Novyy",
                f"{USERNAME} {DEMO_PHONE}",
                "",
                "kg",
                "1000",
                "",
                "",
                "true",
                "0",
                "",
            ]
        )
        response = await client.post(
            "/api/v1/admin/catalog/csv/import",
            content=(BOM + buffer.getvalue()).encode(),
            headers={**staff.csrf, **CSV_HEADERS},
        )
        assert response.status_code == 200, response.text
        assert response.json()["applied"] is True

    async with session_factory() as session:
        rows = list((await session.execute(select(AuditLog))).scalars())
    assert {row.action for row in rows} == {
        "user.role_change",
        "user.block",
        "user.unblock",
        "product.update",
        "category.create",
        "product.create",
        "catalog.import",
    }
    dumped = json.dumps([row.details for row in rows], ensure_ascii=False)
    for secret in (
        DEMO_PHONE,
        "+998977654321",
        "998901234567",
        FIRST_NAME,
        LAST_NAME,
        USERNAME,
        "admin_demo",
        str(customer.telegram_user_id),
        str(admin.telegram_user_id),
        cookie_token,
        csrf_token,
    ):
        assert secret not in dumped, secret
    for forbidden_key in ("phone", "first_name", "last_name", "username", "telegram", "token"):
        assert forbidden_key not in dumped


async def test_audit_log_is_append_only(session_factory: SessionFactory) -> None:
    admin = await add_user(session_factory, role=UserRole.ADMIN)
    async with session_factory() as session:
        record_audit(
            session,
            AuditActor(user_id=admin.id, role=UserRole.ADMIN),
            action="product.update",
            entity_type="product",
            entity_id=uuid.uuid4(),
            changes={"price_uzs": (1, 2)},
        )
        await session.commit()
    for statement in (
        "UPDATE audit_log SET action = 'tampered'",
        "UPDATE audit_log SET details = '{}'::jsonb",
        "DELETE FROM audit_log",
    ):
        async with session_factory() as session:
            with pytest.raises(DBAPIError, match="append-only"):
                await session.execute(text(statement))
            await session.rollback()
    async with session_factory() as session:
        [row] = list((await session.execute(select(AuditLog))).scalars())
    assert row.action == "product.update"
    assert row.details == {"changes": {"price_uzs": {"from": 1, "to": 2}}}


async def test_admins_read_the_log_newest_first(session_factory: SessionFactory) -> None:
    admin = await add_user(session_factory, role=UserRole.ADMIN)
    operator = await add_user(session_factory, role=UserRole.OPERATOR)
    target = uuid.uuid4()
    async with session_factory() as session:
        actor = AuditActor(user_id=admin.id, role=UserRole.ADMIN)
        for index in range(3):
            record_audit(
                session,
                actor,
                action="product.update",
                entity_type="product",
                entity_id=target,
                changes={"price_uzs": (index, index + 1)},
            )
        record_audit(
            session,
            actor,
            action="category.create",
            entity_type="category",
            entity_id=uuid.uuid4(),
        )
        await session.commit()

    app = build_session_app(session_factory)
    async with http_client(app) as client:
        staff = await widget_session(app, admin)
        response = await client.get("/api/v1/admin/audit", headers=staff.cookie)
        assert response.status_code == 200
        body = response.json()
        assert body["total"] == 4
        assert [item["action"] for item in body["items"]] == [
            "category.create",
            "product.update",
            "product.update",
            "product.update",
        ]
        filtered = await client.get(
            "/api/v1/admin/audit",
            params={"entity_type": "product", "entity_id": str(target), "page_size": 2},
            headers=staff.cookie,
        )
        items = filtered.json()["items"]
        assert [item["details"]["changes"]["price_uzs"]["to"] for item in items] == [3, 2]
        assert items[0]["actor_role"] == "admin"
        assert items[0]["actor_user_id"] == str(admin.id)
        by_action = await client.get(
            "/api/v1/admin/audit",
            params={"action": "category.create", "actor_user_id": str(admin.id)},
            headers=staff.cookie,
        )
        assert by_action.json()["total"] == 1

        # Operators cannot read it.
        operator_session = await widget_session(app, operator)
        response = await client.get("/api/v1/admin/audit", headers=operator_session.cookie)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "forbidden"
