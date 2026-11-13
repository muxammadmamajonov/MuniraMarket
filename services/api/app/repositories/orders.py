"""Checkout, orders and the order lifecycle, behind a small interface (faked in route tests).

Locking (every write is one transaction; locks are always taken in this order, so concurrent
writers cannot deadlock):

1. the customer's ``carts`` row (order creation) or the ``orders`` row (status changes),
2. the affected ``products`` rows, ``FOR UPDATE`` in ascending id order.

Order creation, under those locks: replay an earlier order with the same ``Idempotency-Key``;
re-evaluate the cart against current prices, visibility and stock with the same pure function as
the quote; refuse unless the cart is clean and the total equals what the customer was shown; then
decrement tracked stock, snapshot the lines, write the status history and the notification outbox
rows, and empty the cart. Delivery is on demand by a Yandex Go courier whom the customer pays, so
there is no delivery fee, zone or slot to check.

Stock changes go through Core ``update(Product)``, which applies the model's
``onupdate=func.now()`` to ``products.updated_at``: a catalog CSV exported before an order (or a
restock) is then refused as ``stale_row`` instead of writing the old stock back.

Cancelling (by the customer, or an operator) returns tracked stock, and
writes an ``order.status_change`` audit row (no reason text, no recipient data); so does every
other status change. Nothing is ever committed partially: any rule violation rolls the whole
transaction back.
"""

import secrets
import uuid
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from sqlalchemy import and_, delete, func, select, text, update
from sqlalchemy.dialects.postgresql import aggregate_order_by
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import AuditActor, AuditEntity, record_audit
from app.domain.cart import LineFacts
from app.domain.checkout import (
    MAX_OPEN_ORDERS,
    CartEmptyError,
    IdempotencyKeyConflictError,
    InvalidStatusTransitionError,
    OrderInsufficientStockError,
    OrderNotCancellableError,
    OrderNotFoundError,
    OrderProductUnavailableError,
    OrderStatusConflictError,
    PriceChangedError,
    QuoteTotals,
    TooManyOpenOrdersError,
    build_quote,
)
from app.domain.geo import snapshot_point
from app.domain.order_status import (
    ORDER_STATUS_GROUP_STATUSES,
    OrderStatus,
    OrderStatusGroup,
    can_transition,
    customer_can_cancel,
)
from app.domain.tashkent import TASHKENT_TZ
from app.models.cart import Cart, CartItem
from app.models.catalog import Product
from app.models.enums import Language, PaymentMethod, Unit, UserRole
from app.models.notification import NotificationOutbox
from app.models.order import Order, OrderItem, OrderStatusHistory
from app.models.user import User
from app.repositories.cart import CartLineRecord, SqlAlchemyCartRepository
from app.repositories.staff_chat import staff_chat_id

ORDER_STATUS_EVENT = "order.status_changed"
# Staff group alert (ADR 0015): new orders and the statuses the shop floor must react to.
STAFF_ALERT_EVENT = "order.staff_alert"
STAFF_ALERT_STATUSES: frozenset[OrderStatus] = frozenset(
    {
        OrderStatus.NEW,
        OrderStatus.CANCELLED,
        OrderStatus.OUT_FOR_DELIVERY,
        OrderStatus.DELIVERED,
    }
)
AUDIT_STATUS_CHANGE = "order.status_change"
IDEMPOTENCY_CONSTRAINT = "uq_orders_user_id_idempotency_key"
NUMBER_CONSTRAINT = "uq_orders_number"
# Crockford-style alphabet without look-alikes (0/O, 1/I/L, U).
_NUMBER_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
_NUMBER_ATTEMPTS = 5
# Lines shown as thumbnails on an order list card.
ORDER_THUMBNAIL_LIMIT = 4


# --- records --------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class QuoteRecord:
    lines: tuple[CartLineRecord, ...]
    totals: QuoteTotals


@dataclass(frozen=True, slots=True)
class NewOrder:
    # Structured address (``lat``/``lon`` rounded to 6 decimals, street, house, ...); stored as
    # the order's ``address_snapshot``.
    address: dict[str, Any]
    recipient_name: str
    recipient_phone: str
    payment_method: PaymentMethod
    comment: str | None
    expected_total_uzs: int


@dataclass(frozen=True, slots=True)
class Actor:
    user_id: uuid.UUID | None
    role: UserRole


@dataclass(frozen=True, slots=True)
class OrderItemRecord:
    product_id: uuid.UUID | None
    sku: str
    name_uz: str
    name_ru: str
    unit: Unit
    unit_price_uzs: int
    quantity: int
    line_total_uzs: int


@dataclass(frozen=True, slots=True)
class StatusChangeRecord:
    from_status: OrderStatus | None
    to_status: OrderStatus
    actor_role: UserRole
    reason: str | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class OrderRecord:
    id: uuid.UUID
    number: str
    user_id: uuid.UUID
    status: OrderStatus
    subtotal_uzs: int
    total_uzs: int
    item_count: int
    payment_method: PaymentMethod
    recipient_name: str
    recipient_phone: str
    address: dict[str, Any]
    comment: str | None
    cancel_reason: str | None
    created_at: datetime
    updated_at: datetime
    items: tuple[OrderItemRecord, ...]
    history: tuple[StatusChangeRecord, ...]


@dataclass(frozen=True, slots=True)
class OrderThumbnailRecord:
    # ``None`` once the product has been deleted from the catalog.
    product_id: uuid.UUID | None
    name_uz: str
    name_ru: str
    # The product's CURRENT image (as in the catalog); ``None`` when gone or without an image.
    image_url: str | None


@dataclass(frozen=True, slots=True)
class OrderSummaryRecord:
    id: uuid.UUID
    number: str
    status: OrderStatus
    total_uzs: int
    item_count: int
    created_at: datetime
    # The first ``ORDER_THUMBNAIL_LIMIT`` lines, in the order the order detail lists them.
    thumbnails: tuple[OrderThumbnailRecord, ...] = ()


@dataclass(frozen=True, slots=True)
class OrderPageRecord:
    items: tuple[OrderSummaryRecord, ...]
    total: int


@dataclass(frozen=True, slots=True)
class CreatedOrder:
    order: OrderRecord
    # True when an earlier request with the same Idempotency-Key created it.
    replayed: bool


class OrderRepository(Protocol):
    """Rule violations raise the ``app.domain.checkout`` errors."""

    async def quote(self, user_id: uuid.UUID) -> QuoteRecord: ...

    async def create_order(
        self,
        user_id: uuid.UUID,
        new_order: NewOrder,
        *,
        idempotency_key: str,
        request_hash: str,
        now: datetime,
    ) -> CreatedOrder: ...

    async def list_for_user(
        self,
        user_id: uuid.UUID,
        *,
        page: int,
        page_size: int,
        status_group: OrderStatusGroup = OrderStatusGroup.ALL,
    ) -> OrderPageRecord: ...

    async def get_for_user(self, user_id: uuid.UUID, order_id: uuid.UUID) -> OrderRecord | None: ...

    async def cancel_for_user(
        self, user_id: uuid.UUID, order_id: uuid.UUID, reason: str
    ) -> OrderRecord: ...

    # --- operator / admin ---

    async def list_all(
        self, *, status: OrderStatus | None, page: int, page_size: int
    ) -> OrderPageRecord: ...

    async def get(self, order_id: uuid.UUID) -> OrderRecord | None: ...

    async def change_status(
        self,
        order_id: uuid.UUID,
        target: OrderStatus,
        *,
        actor: Actor,
        reason: str | None,
        expected_status: OrderStatus | None,
    ) -> OrderRecord: ...


# --- pure helpers ---------------------------------------------------------------------------------


def _thumbnail(item: dict[str, Any]) -> OrderThumbnailRecord:
    """One element of the page query's ``json_agg`` (JSON, so the UUID arrives as text)."""
    product_id = item["product_id"]
    return OrderThumbnailRecord(
        product_id=uuid.UUID(product_id) if product_id is not None else None,
        name_uz=item["name_uz"],
        name_ru=item["name_ru"],
        image_url=item["image_url"],
    )


def line_facts(lines: Sequence[CartLineRecord]) -> list[LineFacts]:
    return [
        LineFacts(
            price_uzs=line.product.price_uzs,
            quantity=line.quantity,
            is_available=line.is_available,
            stock_quantity=line.product.stock_quantity,
        )
        for line in lines
    ]


def new_order_number(now: datetime) -> str:
    """``YYMMDD-XXXXXX``: the local (Asia/Tashkent) date plus 6 random characters."""
    suffix = "".join(secrets.choice(_NUMBER_ALPHABET) for _ in range(6))
    return f"{now.astimezone(TASHKENT_TZ):%y%m%d}-{suffix}"


def _violated_constraint(error: IntegrityError) -> str | None:
    name = getattr(getattr(error.orig, "__cause__", None), "constraint_name", None)
    if name is None:
        name = getattr(error.orig, "constraint_name", None)
    return name if isinstance(name, str) else None


def first_blocking_error(quote: QuoteRecord) -> Exception | None:
    """The error to refuse an order with, most actionable first."""
    for line, evaluated in zip(quote.lines, quote.totals.lines, strict=True):
        if evaluated.issue == "product_inactive":
            return OrderProductUnavailableError(line.product.id)
        if evaluated.issue == "insufficient_stock":
            return OrderInsufficientStockError(line.product.id, line.product.stock_quantity or 0)
    if "cart_empty" in quote.totals.issues:
        return CartEmptyError()
    return None


# --- SQLAlchemy implementation --------------------------------------------------------------------


class _ReplayError(Exception):
    """Internal: a concurrent request committed an order with this idempotency key first."""


class SqlAlchemyOrderRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._carts = SqlAlchemyCartRepository(session)

    # --- checkout --------------------------------------------------------------------------------

    async def quote(self, user_id: uuid.UUID) -> QuoteRecord:
        cart = await self._carts.get_cart(user_id)
        return QuoteRecord(lines=cart.lines, totals=build_quote(line_facts(cart.lines)))

    async def create_order(
        self,
        user_id: uuid.UUID,
        new_order: NewOrder,
        *,
        idempotency_key: str,
        request_hash: str,
        now: datetime,
    ) -> CreatedOrder:
        try:
            async with self._transaction():
                cart_id = (
                    await self._session.execute(
                        select(Cart.id).where(Cart.user_id == user_id).with_for_update()
                    )
                ).scalar_one_or_none()

                existing = await self._order_id_for_key(user_id, idempotency_key)
                if existing is not None:
                    return await self._replay(existing, request_hash)
                if cart_id is None:
                    raise CartEmptyError()
                # Serialised by the cart lock, so concurrent requests cannot both slip under it.
                open_orders = (
                    await self._session.execute(
                        select(func.count())
                        .select_from(Order)
                        .where(Order.user_id == user_id, Order.status == OrderStatus.NEW)
                    )
                ).scalar_one()
                if open_orders >= MAX_OPEN_ORDERS:
                    raise TooManyOpenOrdersError()

                product_ids = (
                    await self._session.execute(
                        select(CartItem.product_id).where(CartItem.cart_id == cart_id)
                    )
                ).scalars()
                await self._lock_products(list(product_ids))

                cart = await self._carts.get_cart(user_id)
                quote = QuoteRecord(lines=cart.lines, totals=build_quote(line_facts(cart.lines)))
                blocking = first_blocking_error(quote)
                if blocking is not None:
                    raise blocking
                if quote.totals.total_uzs != new_order.expected_total_uzs:
                    raise PriceChangedError(quote.totals.total_uzs)

                order_id = await self._insert_order(
                    user_id,
                    new_order,
                    quote,
                    idempotency_key=idempotency_key,
                    request_hash=request_hash,
                    now=now,
                )
                for line in quote.lines:
                    if line.product.stock_quantity is not None:
                        await self._session.execute(
                            update(Product)
                            .where(Product.id == line.product.id)
                            .values(stock_quantity=Product.stock_quantity - line.quantity)
                        )
                await self._session.execute(delete(CartItem).where(CartItem.cart_id == cart_id))
                await self._session.execute(
                    update(Cart).where(Cart.id == cart_id).values(updated_at=func.now())
                )
                await self._record_change(
                    order_id,
                    from_status=None,
                    to_status=OrderStatus.NEW,
                    actor=Actor(user_id=user_id, role=UserRole.CUSTOMER),
                    reason=None,
                )
                return CreatedOrder(order=await self._load(order_id), replayed=False)
        except _ReplayError:
            # Lost the race to a concurrent request with the same key: that one is the order.
            async with self._transaction():
                existing = await self._order_id_for_key(user_id, idempotency_key)
                if existing is None:  # pragma: no cover - the constraint said it exists
                    raise
                return await self._replay(existing, request_hash)

    # --- customer reads / cancel -----------------------------------------------------------------

    async def list_for_user(
        self,
        user_id: uuid.UUID,
        *,
        page: int,
        page_size: int,
        status_group: OrderStatusGroup = OrderStatusGroup.ALL,
    ) -> OrderPageRecord:
        condition = Order.user_id == user_id
        if status_group is not OrderStatusGroup.ALL:
            condition = and_(condition, Order.status.in_(ORDER_STATUS_GROUP_STATUSES[status_group]))
        return await self._page(condition, page=page, page_size=page_size)

    async def get_for_user(self, user_id: uuid.UUID, order_id: uuid.UUID) -> OrderRecord | None:
        owned = (
            await self._session.execute(
                select(Order.id).where(Order.id == order_id, Order.user_id == user_id)
            )
        ).scalar_one_or_none()
        return None if owned is None else await self._load(owned)

    async def cancel_for_user(
        self, user_id: uuid.UUID, order_id: uuid.UUID, reason: str
    ) -> OrderRecord:
        async with self._transaction():
            order = await self._lock_order(order_id, user_id=user_id)
            if order is None:
                raise OrderNotFoundError()
            if not customer_can_cancel(order.status):
                raise OrderNotCancellableError(order.status.value)
            await self._apply_status(
                order,
                OrderStatus.CANCELLED,
                actor=Actor(user_id=user_id, role=UserRole.CUSTOMER),
                reason=reason,
            )
            return await self._load(order.id)

    # --- operator / admin ------------------------------------------------------------------------

    async def list_all(
        self, *, status: OrderStatus | None, page: int, page_size: int
    ) -> OrderPageRecord:
        condition = Order.status == status if status is not None else None
        return await self._page(condition, page=page, page_size=page_size)

    async def get(self, order_id: uuid.UUID) -> OrderRecord | None:
        exists = (
            await self._session.execute(select(Order.id).where(Order.id == order_id))
        ).scalar_one_or_none()
        return None if exists is None else await self._load(exists)

    async def change_status(
        self,
        order_id: uuid.UUID,
        target: OrderStatus,
        *,
        actor: Actor,
        reason: str | None,
        expected_status: OrderStatus | None,
    ) -> OrderRecord:
        async with self._transaction():
            order = await self._lock_order(order_id)
            if order is None:
                raise OrderNotFoundError()
            if expected_status is not None and order.status != expected_status:
                raise OrderStatusConflictError(order.status.value)
            if not can_transition(order.status, target, cancel_reason=reason):
                raise InvalidStatusTransitionError(order.status.value)
            await self._apply_status(order, target, actor=actor, reason=reason)
            return await self._load(order.id)

    # --- internals -------------------------------------------------------------------------------

    @asynccontextmanager
    async def _transaction(self) -> AsyncIterator[None]:
        try:
            yield
            await self._session.commit()
        except BaseException:
            await self._session.rollback()
            raise

    async def _order_id_for_key(self, user_id: uuid.UUID, key: str) -> uuid.UUID | None:
        return (
            await self._session.execute(
                select(Order.id).where(Order.user_id == user_id, Order.idempotency_key == key)
            )
        ).scalar_one_or_none()

    async def _replay(self, order_id: uuid.UUID, request_hash: str) -> CreatedOrder:
        stored_hash = (
            await self._session.execute(
                select(Order.idempotency_request_hash).where(Order.id == order_id)
            )
        ).scalar_one()
        if not secrets.compare_digest(stored_hash, request_hash):
            raise IdempotencyKeyConflictError()
        return CreatedOrder(order=await self._load(order_id), replayed=True)

    async def _lock_products(self, product_ids: list[uuid.UUID]) -> None:
        if product_ids:
            await self._session.execute(
                select(Product.id)
                .where(Product.id.in_(product_ids))
                .order_by(Product.id)
                .with_for_update()
            )

    async def _insert_order(
        self,
        user_id: uuid.UUID,
        new_order: NewOrder,
        quote: QuoteRecord,
        *,
        idempotency_key: str,
        request_hash: str,
        now: datetime,
    ) -> uuid.UUID:
        totals = quote.totals
        for _ in range(_NUMBER_ATTEMPTS):
            order = Order(
                number=new_order_number(now),
                user_id=user_id,
                status=OrderStatus.NEW,
                subtotal_uzs=totals.subtotal_uzs,
                total_uzs=totals.total_uzs,
                item_count=totals.cart.item_count,
                payment_method=new_order.payment_method,
                recipient_name=new_order.recipient_name,
                recipient_phone=new_order.recipient_phone,
                address_snapshot=new_order.address,
                comment=new_order.comment,
                idempotency_key=idempotency_key,
                idempotency_request_hash=request_hash,
            )
            try:
                async with self._session.begin_nested():
                    self._session.add(order)
                    await self._session.flush()
            except IntegrityError as error:
                constraint = _violated_constraint(error)
                if constraint == IDEMPOTENCY_CONSTRAINT:
                    raise _ReplayError from None
                if constraint == NUMBER_CONSTRAINT:
                    continue
                raise
            for line in quote.lines:
                self._session.add(
                    OrderItem(
                        order_id=order.id,
                        product_id=line.product.id,
                        sku=line.product.sku,
                        name_uz=line.product.name_uz,
                        name_ru=line.product.name_ru,
                        unit=line.product.unit,
                        unit_price_uzs=line.product.price_uzs,
                        quantity=line.quantity,
                        line_total_uzs=line.product.price_uzs * line.quantity,
                        stock_decremented=line.product.stock_quantity is not None,
                    )
                )
            await self._session.flush()
            return order.id
        raise RuntimeError("could not allocate a unique order number")

    async def _lock_order(
        self, order_id: uuid.UUID, *, user_id: uuid.UUID | None = None
    ) -> Order | None:
        statement = select(Order).where(Order.id == order_id).with_for_update()
        if user_id is not None:
            statement = statement.where(Order.user_id == user_id)
        return (await self._session.execute(statement)).scalar_one_or_none()

    async def _apply_status(
        self, order: Order, target: OrderStatus, *, actor: Actor, reason: str | None
    ) -> None:
        """Move a locked order to ``target`` (already validated) and record everything."""
        previous = order.status
        values: dict[str, Any] = {"status": target, "updated_at": func.now()}
        if target is OrderStatus.CANCELLED:
            values["cancel_reason"] = reason
            await self._restock(order.id)
        await self._session.execute(update(Order).where(Order.id == order.id).values(**values))
        await self._record_change(
            order.id,
            from_status=previous,
            to_status=target,
            actor=actor,
            reason=reason if target is OrderStatus.CANCELLED else None,
        )
        # The reason is free text (it may name people or places): only whether there was one.
        record_audit(
            self._session,
            AuditActor(user_id=actor.user_id, role=actor.role),
            action=AUDIT_STATUS_CHANGE,
            entity_type=AuditEntity.ORDER,
            entity_id=order.id,
            changes={"status": (previous, target)},
            extra={"order_number": order.number, "has_reason": bool(reason)},
        )

    async def _restock(self, order_id: uuid.UUID) -> None:
        items = (
            await self._session.execute(
                select(OrderItem.product_id, OrderItem.quantity).where(
                    OrderItem.order_id == order_id,
                    OrderItem.product_id.is_not(None),
                    # Only what this order actually took: a product that became tracked after the
                    # order was placed must not gain units that were never decremented.
                    OrderItem.stock_decremented.is_(True),
                )
            )
        ).all()
        quantities: dict[uuid.UUID, int] = {}
        for product_id, quantity in items:
            if product_id is not None:
                quantities[product_id] = quantities.get(product_id, 0) + quantity
        await self._lock_products(list(quantities))
        for product_id in sorted(quantities):
            await self._session.execute(
                update(Product)
                .where(Product.id == product_id, Product.stock_quantity.is_not(None))
                .values(stock_quantity=Product.stock_quantity + quantities[product_id])
            )

    async def _record_change(
        self,
        order_id: uuid.UUID,
        *,
        from_status: OrderStatus | None,
        to_status: OrderStatus,
        actor: Actor,
        reason: str | None,
    ) -> None:
        self._session.add(
            OrderStatusHistory(
                order_id=order_id,
                from_status=from_status,
                to_status=to_status,
                actor_user_id=actor.user_id,
                actor_role=actor.role,
                reason=reason,
                created_at=func.clock_timestamp(),
            )
        )
        row = (
            await self._session.execute(
                select(
                    Order.number,
                    Order.total_uzs,
                    Order.address_snapshot,
                    User.telegram_user_id,
                    User.language,
                )
                .join(User, User.id == Order.user_id)
                .where(Order.id == order_id)
            )
        ).one()
        payload: dict[str, Any] = {
            "order_id": str(order_id),
            "order_number": row.number,
            "status": to_status.value,
            "locale": Language(row.language).value,
            "total_uzs": row.total_uzs,
            "chat_id": row.telegram_user_id,
        }
        if to_status is OrderStatus.CANCELLED and reason:
            payload["cancel_reason"] = reason
        self._session.add(
            NotificationOutbox(event_type=ORDER_STATUS_EVENT, order_id=order_id, payload=payload)
        )
        if to_status in STAFF_ALERT_STATUSES:
            group_chat_id = await staff_chat_id(self._session)
            if group_chat_id is not None:
                # Same transaction as the change: an alert exists iff the change committed.
                # No customer name, address text or phone: staff open the order in the admin.
                staff_payload: dict[str, Any] = {
                    "order_id": str(order_id),
                    "order_number": row.number,
                    "status": to_status.value,
                    "previous_status": from_status.value if from_status is not None else None,
                    "total_uzs": row.total_uzs,
                    "chat_id": group_chat_id,
                    "cancelled_by_customer": (
                        to_status is OrderStatus.CANCELLED and actor.role is UserRole.CUSTOMER
                    ),
                }
                # A new order's drop-off point, only inside the "call a Yandex Go courier" button.
                destination = snapshot_point(row.address_snapshot)
                if to_status is OrderStatus.NEW and destination is not None:
                    staff_payload["destination"] = {"lat": destination.lat, "lon": destination.lon}
                self._session.add(
                    NotificationOutbox(
                        event_type=STAFF_ALERT_EVENT, order_id=order_id, payload=staff_payload
                    )
                )
        await self._session.flush()

    async def _page(self, condition: Any, *, page: int, page_size: int) -> OrderPageRecord:
        """One page of order summaries, newest first, with each order's thumbnails.

        Two statements whatever the page size: the count, and the page itself, whose thumbnails
        come from a correlated ``json_agg`` subquery (no query per order).
        """
        conditions = [] if condition is None else [condition]
        total = (
            await self._session.execute(select(func.count()).select_from(Order).where(*conditions))
        ).scalar_one()
        offset = (page - 1) * page_size
        if offset >= total:
            return OrderPageRecord(items=(), total=total)
        first_lines = (
            select(
                OrderItem.id,
                OrderItem.product_id,
                OrderItem.name_uz,
                OrderItem.name_ru,
                Product.image_url,
            )
            .select_from(OrderItem)
            .outerjoin(Product, Product.id == OrderItem.product_id)
            .where(OrderItem.order_id == Order.id)
            .order_by(OrderItem.name_uz, OrderItem.id)
            .limit(ORDER_THUMBNAIL_LIMIT)
            .correlate(Order)
            .subquery("first_lines")
        )
        thumbnails = (
            select(
                func.coalesce(
                    func.json_agg(
                        aggregate_order_by(
                            func.json_build_object(
                                "product_id",
                                first_lines.c.product_id,
                                "name_uz",
                                first_lines.c.name_uz,
                                "name_ru",
                                first_lines.c.name_ru,
                                "image_url",
                                first_lines.c.image_url,
                            ),
                            first_lines.c.name_uz,
                            first_lines.c.id,
                        )
                    ),
                    text("'[]'::json"),
                )
            )
            .select_from(first_lines)
            .scalar_subquery()
        )
        rows = (
            await self._session.execute(
                select(
                    Order.id,
                    Order.number,
                    Order.status,
                    Order.total_uzs,
                    Order.item_count,
                    Order.created_at,
                    thumbnails.label("thumbnails"),
                )
                .where(*conditions)
                .order_by(Order.created_at.desc(), Order.id.desc())
                .limit(page_size)
                .offset(offset)
            )
        ).all()
        return OrderPageRecord(
            items=tuple(
                OrderSummaryRecord(
                    id=row.id,
                    number=row.number,
                    status=row.status,
                    total_uzs=row.total_uzs,
                    item_count=row.item_count,
                    created_at=row.created_at,
                    thumbnails=tuple(_thumbnail(item) for item in row.thumbnails),
                )
                for row in rows
            ),
            total=total,
        )

    async def _load(self, order_id: uuid.UUID) -> OrderRecord:
        order = (
            await self._session.execute(
                select(Order).where(Order.id == order_id).execution_options(populate_existing=True)
            )
        ).scalar_one()
        items = (
            await self._session.execute(
                select(OrderItem)
                .where(OrderItem.order_id == order_id)
                .order_by(OrderItem.name_uz, OrderItem.id)
            )
        ).scalars()
        history = (
            await self._session.execute(
                select(OrderStatusHistory)
                .where(OrderStatusHistory.order_id == order_id)
                .order_by(OrderStatusHistory.created_at, OrderStatusHistory.id)
            )
        ).scalars()
        return OrderRecord(
            id=order.id,
            number=order.number,
            user_id=order.user_id,
            status=order.status,
            subtotal_uzs=order.subtotal_uzs,
            total_uzs=order.total_uzs,
            item_count=order.item_count,
            payment_method=order.payment_method,
            recipient_name=order.recipient_name,
            recipient_phone=order.recipient_phone,
            address=dict(order.address_snapshot),
            comment=order.comment,
            cancel_reason=order.cancel_reason,
            created_at=order.created_at,
            updated_at=order.updated_at,
            items=tuple(
                OrderItemRecord(
                    product_id=item.product_id,
                    sku=item.sku,
                    name_uz=item.name_uz,
                    name_ru=item.name_ru,
                    unit=item.unit,
                    unit_price_uzs=item.unit_price_uzs,
                    quantity=item.quantity,
                    line_total_uzs=item.line_total_uzs,
                )
                for item in items
            ),
            history=tuple(
                StatusChangeRecord(
                    from_status=change.from_status,
                    to_status=change.to_status,
                    actor_role=change.actor_role,
                    reason=change.reason,
                    created_at=change.created_at,
                )
                for change in history
            ),
        )
