"""Import every model so ``Base.metadata`` is complete (Alembic autogenerate relies on it)."""

from app.models.cart import Cart, CartItem
from app.models.catalog import Category, Product
from app.models.order import Order, OrderItem
from app.models.user import User

__all__ = ["Cart", "CartItem", "Category", "Order", "OrderItem", "Product", "User"]
