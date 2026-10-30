from fastapi import APIRouter

from app.api.routes import auth, cart, catalog, health, internal_telegram

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(internal_telegram.router)
api_router.include_router(catalog.router)
api_router.include_router(cart.router)
