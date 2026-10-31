"""The dev seed: environment guard and the shape of its (synthetic) data, plus (against a real
database, ``integration``) that the delivery slots are idempotent and only where intended."""

import re
from datetime import UTC, date, datetime, time, timedelta

import pytest
from sqlalchemy import func, select, update

from app.dev.seed import (
    DEMO_CATEGORIES,
    DEMO_PRODUCTS,
    DEMO_ZONES,
    SLOT_CUTOFF_BEFORE_START,
    SLOT_DAYS,
    SLOT_WINDOWS,
    SLOT_ZONE_SLUG,
    SeedRefusedError,
    demo_slot_days,
    ensure_safe_environment,
    seed,
)
from app.domain.delivery import is_district_code, tashkent_instant
from app.models.catalog import Product
from app.models.delivery import DeliverySlot, DeliveryZone
from app.repositories.delivery import SqlAlchemyDeliveryZoneRepository
from tests.db_data import SessionFactory

pytest_plugins = ["tests.db_fixtures"]  # the session_factory fixture (integration test only)

# The district the storefront E2E checkout (apps/web/e2e/checkout.spec.ts) orders to.
E2E_DISTRICT = "yunusobod"


@pytest.mark.parametrize("app_env", ["development", "test"])
def test_allowed_environments(app_env: str) -> None:
    ensure_safe_environment(app_env)


@pytest.mark.parametrize("app_env", ["production", "staging", "", "prod", "Development"])
def test_refuses_everything_else(app_env: str) -> None:
    with pytest.raises(SeedRefusedError):
        ensure_safe_environment(app_env)


def test_data_is_obviously_synthetic() -> None:
    for product in DEMO_PRODUCTS:
        assert re.fullmatch(r"DEMO-\d{4}", product.sku)
        assert product.slug.startswith("demo-")
        assert product.name_uz.startswith("Demo ")
        assert product.name_ru.startswith("Демо ")
        assert product.price_uzs % 1000 == 0
    for category in DEMO_CATEGORIES:
        assert category.slug.startswith("demo-")
        assert category.name_uz.startswith("Demo ")
        assert category.name_ru.startswith("Демо ")


def test_keys_are_unique_and_references_resolve() -> None:
    category_slugs = [category.slug for category in DEMO_CATEGORIES]
    assert len(set(category_slugs)) == len(category_slugs)
    assert len({product.sku for product in DEMO_PRODUCTS}) == len(DEMO_PRODUCTS)
    assert len({product.slug for product in DEMO_PRODUCTS}) == len(DEMO_PRODUCTS)
    seen: set[str] = set()
    for category in DEMO_CATEGORIES:  # parents are declared before children
        assert category.parent_slug is None or category.parent_slug in seen
        seen.add(category.slug)
    assert all(product.category_slug in seen for product in DEMO_PRODUCTS)


def test_covers_the_edge_cases_the_shop_must_handle() -> None:
    assert any(product.old_price_uzs for product in DEMO_PRODUCTS)
    assert any(product.stock_quantity is None for product in DEMO_PRODUCTS)
    assert any(product.stock_quantity == 0 for product in DEMO_PRODUCTS)
    assert any(not product.is_active for product in DEMO_PRODUCTS)
    assert any(not category.is_active for category in DEMO_CATEGORIES)
    for product in DEMO_PRODUCTS:
        assert product.old_price_uzs is None or product.old_price_uzs > product.price_uzs
        assert product.stock_quantity is None or product.stock_quantity >= 0


def test_delivery_zones_are_synthetic_and_consistent() -> None:
    slugs = [zone.slug for zone in DEMO_ZONES]
    assert len(set(slugs)) == len(slugs)
    districts = [district for zone in DEMO_ZONES for district in zone.districts]
    # A district is in at most one zone (``delivery_zone_districts`` has it as primary key).
    assert len(set(districts)) == len(districts)
    assert all(is_district_code(district) for district in districts)
    for zone in DEMO_ZONES:
        assert zone.slug.startswith("demo-")
        assert zone.name_uz.startswith("Demo ")
        assert zone.name_ru.startswith("Демо ")
        assert zone.districts
        assert zone.opens_at < zone.closes_at
        assert zone.delivery_fee_uzs > 0
        assert zone.delivery_fee_uzs % 1000 == 0
        assert zone.min_order_uzs % 1000 == 0
        threshold = zone.free_delivery_threshold_uzs
        assert threshold is None or (threshold % 1000 == 0 and threshold > zone.min_order_uzs)


def test_delivery_zones_cover_the_edge_cases() -> None:
    assert any(not zone.is_active for zone in DEMO_ZONES)
    assert any(zone.is_active for zone in DEMO_ZONES)
    assert any(zone.free_delivery_threshold_uzs is None for zone in DEMO_ZONES if zone.is_active)
    assert any(zone.free_delivery_threshold_uzs is not None for zone in DEMO_ZONES)


# --- delivery slots -------------------------------------------------------------------------------


def test_slots_belong_to_one_active_zone_the_e2e_checkout_does_not_use() -> None:
    """A zone with slots requires one at checkout; the E2E checkout (which sends no slot) must
    keep working, so its zone has none."""
    [zone] = [zone for zone in DEMO_ZONES if zone.slug == SLOT_ZONE_SLUG]
    assert zone.is_active
    assert E2E_DISTRICT not in zone.districts
    assert any(E2E_DISTRICT in other.districts and other.is_active for other in DEMO_ZONES)


def test_slot_windows_fit_the_zone_hours() -> None:
    [zone] = [zone for zone in DEMO_ZONES if zone.slug == SLOT_ZONE_SLUG]
    assert SLOT_WINDOWS
    for starts_at, ends_at in SLOT_WINDOWS:
        assert zone.opens_at <= starts_at < ends_at <= zone.closes_at
    assert SLOT_CUTOFF_BEFORE_START.total_seconds() > 0
    assert demo_slot_days(date(2026, 12, 30)) == [
        date(2026, 12, 30) + timedelta(days=offset) for offset in range(SLOT_DAYS)
    ]


@pytest.mark.integration
@pytest.mark.asyncio(loop_scope="module")
async def test_seed_slots_are_idempotent(session_factory: SessionFactory) -> None:
    today = date(2026, 11, 1)
    first = await seed(session_factory, today=today)
    assert first.slots_written == SLOT_DAYS * len(SLOT_WINDOWS)
    again = await seed(session_factory, today=today)
    assert (
        again.categories_written,
        again.products_written,
        again.zones_written,
        again.slots_written,
    ) == (0, 0, 0, 0)

    async with session_factory() as session:
        slots = list(
            (
                await session.execute(
                    select(DeliverySlot).order_by(DeliverySlot.slot_date, DeliverySlot.starts_at)
                )
            ).scalars()
        )
        zone_id = (
            await session.execute(
                select(DeliveryZone.id).where(DeliveryZone.slug == SLOT_ZONE_SLUG)
            )
        ).scalar_one()
    assert {slot.zone_id for slot in slots} == {zone_id}
    assert [slot.slot_date for slot in slots[:: len(SLOT_WINDOWS)]] == demo_slot_days(today)
    for slot in slots:
        assert slot.cutoff_at == tashkent_instant(slot.slot_date, slot.starts_at) - (
            SLOT_CUTOFF_BEFORE_START
        )
        assert slot.reserved_count == 0

    # Bookings are never touched by a re-run; a later day only adds its new days.
    async with session_factory() as session:
        await session.execute(
            update(DeliverySlot).where(DeliverySlot.id == slots[0].id).values(reserved_count=3)
        )
        await session.commit()
    later = await seed(session_factory, today=today + timedelta(days=1))
    assert later.slots_written == len(SLOT_WINDOWS)
    async with session_factory() as session:
        assert (
            await session.execute(
                select(DeliverySlot.reserved_count).where(DeliverySlot.id == slots[0].id)
            )
        ).scalar_one() == 3
        assert (
            await session.execute(select(func.count()).select_from(DeliverySlot))
        ).scalar_one() == (SLOT_DAYS + 1) * len(SLOT_WINDOWS)

        # Checkout: slots are required in the slot zone only, not where the E2E orders.
        zones = SqlAlchemyDeliveryZoneRepository(session)
        now = datetime.combine(today, time(5, 0), tzinfo=UTC)  # 10:00 in Tashkent
        slotted = await zones.find_for_district("chilonzor")
        e2e = await zones.find_for_district(E2E_DISTRICT)
        assert slotted is not None
        assert e2e is not None
        assert slotted.slug == SLOT_ZONE_SLUG
        assert await zones.has_bookable_slot(slotted.zone_id, now)
        assert not await zones.has_bookable_slot(e2e.zone_id, now)
        assert len(await zones.offered_slots(slotted.zone_id, now)) > 0


@pytest.mark.integration
@pytest.mark.asyncio(loop_scope="module")
async def test_seed_leaves_archived_demo_products_alone(session_factory: SessionFactory) -> None:
    """An admin archived a demo product (and changed it): a re-run neither reactivates nor
    updates it, and does not trip ``ck_products_archived_is_inactive``."""
    today = date(2026, 11, 1)
    await seed(session_factory, today=today)
    target = next(product for product in DEMO_PRODUCTS if product.is_active)
    async with session_factory() as session:
        await session.execute(
            update(Product)
            .where(Product.slug == target.slug)
            .values(is_active=False, archived_at=func.now(), price_uzs=target.price_uzs + 1000)
        )
        await session.commit()
        before = (
            await session.execute(select(Product.__table__).where(Product.slug == target.slug))
        ).one()

    again = await seed(session_factory, today=today)
    assert again.products_written == 0
    async with session_factory() as session:
        after = (
            await session.execute(select(Product.__table__).where(Product.slug == target.slug))
        ).one()
        active = (
            await session.execute(
                select(func.count()).select_from(Product).where(Product.is_active.is_(True))
            )
        ).scalar_one()
    assert after == before
    assert (after.is_active, after.archived_at is not None) == (False, True)
    assert active == sum(1 for product in DEMO_PRODUCTS if product.is_active) - 1
