"""Import every model so ``Base.metadata`` is complete (Alembic autogenerate relies on it)."""

from app.models.audit import AuditLog
from app.models.cart import Cart, CartItem
from app.models.catalog import Category, Product
from app.models.delivery import DeliverySlot, DeliveryZone, DeliveryZoneDistrict
from app.models.notification import NotificationOutbox, StaffNotificationChat
from app.models.order import Order, OrderItem, OrderStatusHistory
from app.models.security_state import (
    AuthSession,
    OidcLoginState,
    RateLimitCounter,
    ServiceRequestNonce,
)
from app.models.user import User

__all__ = [
    "AuditLog",
    "AuthSession",
    "Cart",
    "CartItem",
    "Category",
    "DeliverySlot",
    "DeliveryZone",
    "DeliveryZoneDistrict",
    "NotificationOutbox",
    "OidcLoginState",
    "Order",
    "OrderItem",
    "OrderStatusHistory",
    "Product",
    "RateLimitCounter",
    "ServiceRequestNonce",
    "StaffNotificationChat",
    "User",
]
