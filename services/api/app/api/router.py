from fastapi import APIRouter

from app.api.routes import (
    admin_orders,
    auth,
    cart,
    catalog,
    delivery,
    health,
    internal_notifications,
    internal_telegram,
    orders,
)

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(internal_telegram.router)
api_router.include_router(internal_notifications.router)
api_router.include_router(catalog.router)
api_router.include_router(delivery.router)
api_router.include_router(cart.router)
api_router.include_router(orders.checkout_router)
api_router.include_router(orders.router)
api_router.include_router(admin_orders.router)
