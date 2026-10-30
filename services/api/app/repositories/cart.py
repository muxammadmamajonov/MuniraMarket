"""Cart persistence behind a small interface so routes can be tested without a database.

Every write is one transaction:

1. ``INSERT ... ON CONFLICT DO NOTHING`` the user's cart (get-or-create without a race),
2. ``SELECT ... FOR UPDATE`` the cart row, which serialises all concurrent writes of that user,
3. validate against the current product row (active, stock, limits) and upsert the line with
   ``ON CONFLICT (cart_id, product_id)``,
4. bump ``carts.updated_at`` and commit.

The cart never reserves stock; checkout re-validates. Rule violations are raised as the domain
errors from ``app.domain.cart``.
"""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Protocol

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.cart import (
    CartItemNotFoundError,
    ProductInactiveError,
    ProductNotFoundError,
    check_can_add_line,
    check_line_quantity,
)
from app.models.cart import Cart, CartItem
from app.models.catalog import Product
from app.repositories.catalog import (
    PRODUCT_SUMMARY_COLUMNS,
    ProductSummaryRecord,
    product_is_visible,
    summary_from_row,
    visible_category_cte,
)

CART_ITEMS_UNIQUE = "uq_cart_items_cart_id_product_id"


@dataclass(frozen=True, slots=True)
class CartLineRecord:
    product: ProductSummaryRecord
    quantity: int
    # Product active and its whole category chain active.
    is_available: bool


@dataclass(frozen=True, slots=True)
class CartRecord:
    lines: tuple[CartLineRecord, ...]


class CartRepository(Protocol):
    """Writes return the resulting cart. Rule violations raise ``app.domain.cart.CartError``."""

    async def get_cart(self, user_id: uuid.UUID) -> CartRecord: ...

    async def add_item(
        self, user_id: uuid.UUID, product_id: uuid.UUID, quantity: int
    ) -> CartRecord: ...

    async def set_item_quantity(
        self, user_id: uuid.UUID, product_id: uuid.UUID, quantity: int
    ) -> CartRecord: ...

    async def remove_item(self, user_id: uuid.UUID, product_id: uuid.UUID) -> CartRecord: ...


@dataclass(frozen=True, slots=True)
class _ProductFacts:
    is_available: bool
    stock_quantity: int | None


class SqlAlchemyCartRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_cart(self, user_id: uuid.UUID) -> CartRecord:
        # Reading never creates a cart.
        cart_id = (
            await self._session.execute(select(Cart.id).where(Cart.user_id == user_id))
        ).scalar_one_or_none()
        if cart_id is None:
            return CartRecord(lines=())
        return await self._load(cart_id)

    async def add_item(
        self, user_id: uuid.UUID, product_id: uuid.UUID, quantity: int
    ) -> CartRecord:
        async with self._transaction():
            cart_id = await self._lock_or_create_cart(user_id)
            facts = await self._product_facts(product_id)
            if facts is None:
                raise ProductNotFoundError(product_id)
            if not facts.is_available:
                raise ProductInactiveError(product_id)

            existing = (
                await self._session.execute(
                    select(CartItem.quantity).where(
                        CartItem.cart_id == cart_id, CartItem.product_id == product_id
                    )
                )
            ).scalar_one_or_none()
            if existing is None:
                line_count = (
                    await self._session.execute(
                        select(func.count())
                        .select_from(CartItem)
                        .where(CartItem.cart_id == cart_id)
                    )
                ).scalar_one()
                check_can_add_line(existing_lines=line_count)
            new_quantity = (existing or 0) + quantity
            check_line_quantity(quantity=new_quantity, stock_quantity=facts.stock_quantity)

            insert_stmt = insert(CartItem).values(
                cart_id=cart_id,
                product_id=product_id,
                quantity=new_quantity,
                # Wall-clock time (not the transaction start) so lines sort by when they were added.
                created_at=func.clock_timestamp(),
            )
            await self._session.execute(
                insert_stmt.on_conflict_do_update(
                    constraint=CART_ITEMS_UNIQUE,
                    set_={"quantity": insert_stmt.excluded.quantity},
                )
            )
            await self._touch(cart_id)
            return await self._load(cart_id)

    async def set_item_quantity(
        self, user_id: uuid.UUID, product_id: uuid.UUID, quantity: int
    ) -> CartRecord:
        async with self._transaction():
            cart_id = await self._lock_existing_cart(user_id)
            if cart_id is None:
                raise CartItemNotFoundError(product_id)
            line_id = (
                await self._session.execute(
                    select(CartItem.id).where(
                        CartItem.cart_id == cart_id, CartItem.product_id == product_id
                    )
                )
            ).scalar_one_or_none()
            if line_id is None:
                raise CartItemNotFoundError(product_id)

            facts = await self._product_facts(product_id)
            if facts is None:  # pragma: no cover - the FK guarantees the product exists
                raise ProductNotFoundError(product_id)
            if not facts.is_available:
                raise ProductInactiveError(product_id)
            check_line_quantity(quantity=quantity, stock_quantity=facts.stock_quantity)

            await self._session.execute(
                update(CartItem).where(CartItem.id == line_id).values(quantity=quantity)
            )
            await self._touch(cart_id)
            return await self._load(cart_id)

    async def remove_item(self, user_id: uuid.UUID, product_id: uuid.UUID) -> CartRecord:
        async with self._transaction():
            cart_id = await self._lock_existing_cart(user_id)
            if cart_id is None:
                return CartRecord(lines=())
            deleted = await self._session.execute(
                delete(CartItem)
                .where(CartItem.cart_id == cart_id, CartItem.product_id == product_id)
                .returning(CartItem.id)
            )
            if deleted.first() is not None:
                await self._touch(cart_id)
            return await self._load(cart_id)

    # --- internals ---------------------------------------------------------------------------

    @asynccontextmanager
    async def _transaction(self) -> AsyncIterator[None]:
        try:
            yield
            await self._session.commit()
        except BaseException:
            await self._session.rollback()
            raise

    async def _lock_or_create_cart(self, user_id: uuid.UUID) -> uuid.UUID:
        await self._session.execute(
            insert(Cart)
            .values(user_id=user_id)
            .on_conflict_do_nothing(index_elements=[Cart.user_id])
        )
        cart_id = await self._lock_existing_cart(user_id)
        if cart_id is None:  # pragma: no cover - the insert above guarantees the row
            raise RuntimeError("cart row missing after get-or-create")
        return cart_id

    async def _lock_existing_cart(self, user_id: uuid.UUID) -> uuid.UUID | None:
        return (
            await self._session.execute(
                select(Cart.id).where(Cart.user_id == user_id).with_for_update()
            )
        ).scalar_one_or_none()

    async def _product_facts(self, product_id: uuid.UUID) -> _ProductFacts | None:
        visible = visible_category_cte()
        row = (
            await self._session.execute(
                select(
                    Product.stock_quantity,
                    product_is_visible(visible).label("is_available"),
                ).where(Product.id == product_id)
            )
        ).first()
        if row is None:
            return None
        return _ProductFacts(is_available=row.is_available, stock_quantity=row.stock_quantity)

    async def _touch(self, cart_id: uuid.UUID) -> None:
        await self._session.execute(
            update(Cart).where(Cart.id == cart_id).values(updated_at=func.now())
        )

    async def _load(self, cart_id: uuid.UUID) -> CartRecord:
        visible = visible_category_cte()
        rows = (
            await self._session.execute(
                select(
                    *PRODUCT_SUMMARY_COLUMNS,
                    CartItem.quantity.label("line_quantity"),
                    product_is_visible(visible).label("is_available"),
                )
                .select_from(CartItem)
                .join(Product, Product.id == CartItem.product_id)
                .where(CartItem.cart_id == cart_id)
                .order_by(CartItem.created_at, CartItem.id)
            )
        ).all()
        return CartRecord(lines=tuple(_to_line(row) for row in rows))


def _to_line(row: Any) -> CartLineRecord:
    return CartLineRecord(
        product=summary_from_row(row),
        quantity=row.line_quantity,
        is_available=row.is_available,
    )
